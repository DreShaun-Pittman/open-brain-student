// backfill-links — builds the thought graph for thoughts saved before auto-linking
//
// POST { batch_size?: number, offset?: number }
//   -> { processed, linked, already_done, offset_next, remaining }
//
// Walks through every thought that has an embedding, oldest first. For each
// one it asks find_links_for_thought for neighbors more than 50% similar
// (same user only) and saves a link to each.
//
// Unlike the course version, it does NOT skip a thought just because some
// earlier thought already linked TO it: that would leave many thoughts with
// only incoming links and never their own neighbors. Links that already exist
// in either direction are refused by the database (code 23505) and skipped,
// so running this twice is harmless. No AI calls here, so it costs nothing.
//
// Only you can run it: send your service role key or sb_secret_ key.

import { createClient } from 'npm:@supabase/supabase-js@2';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Is the caller holding a real admin key for THIS project?
// 1. Fast path: it is exactly the key Supabase gave this function.
// 2. Otherwise ask Supabase itself: an admin-only endpoint answers only for a
//    genuine service_role / secret key of this project. A made-up or public key
//    is refused there, so nobody can fake their way in.
async function isAdminKey(req: Request, supabaseUrl: string, serviceKey: string): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  if (serviceKey && token === serviceKey) return true;
  if (token.startsWith('sb_publishable_')) return false;
  try {
    // New sb_secret_ keys go ONLY in the apikey header. Legacy eyJ... keys need
    // the Authorization header too, or the auth server refuses them.
    const headers: Record<string, string> = { apikey: token };
    if (token.startsWith('eyJ')) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, { headers });
    return res.ok;
  } catch {
    return false;
  }
}

// When the key is wrong, say WHICH kind of key was sent (never the key itself),
// so you can tell "copied the anon key" apart from "pasted nothing".
function describeKey(req: Request): string {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return 'no key was sent';
  if (token.startsWith('sb_secret_')) return 'you sent an sb_secret_ key but Supabase did not accept it (check you copied the whole key)';
  if (token.startsWith('sb_publishable_')) return 'you sent the publishable key; use the legacy service_role key (starts with eyJ)';
  if (token.startsWith('eyJ')) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.role === 'anon') return 'you sent the anon key; copy the one labeled service_role instead';
      if (payload.role === 'service_role') return `this is a service_role key for project ${payload.ref}, but Supabase did not accept it (legacy keys may be turned off; try the sb_secret_ key)`;
      return `key role is ${payload.role}`;
    } catch {
      return `key starts with eyJ but could not be read (${token.length} characters; it may be cut off)`;
    }
  }
  return `unrecognized key (${token.length} characters, starts with ${token.slice(0, 3)}...)`;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!(await isAdminKey(req, supabaseUrl, serviceKey))) {
    return json({ error: 'Unauthorized: send your service role key as the Bearer token', hint: describeKey(req) }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(Math.max(Number(body?.batch_size) || 3, 1), 20);
    const offset = Math.max(Number(body?.offset) || 0, 0);

    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: rows, error } = await supabase
      .from('thoughts')
      .select('id, user_id, embedding')
      .not('embedding', 'is', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + batchSize - 1);
    if (error) return json({ error: error.message }, 500);

    let linked = 0;
    let alreadyDone = 0;

    for (const row of rows ?? []) {
      if (!row.user_id) { alreadyDone++; continue; }

      const { data: neighbors, error: rpcErr } = await supabase.rpc('find_links_for_thought', {
        source_id: row.id,
        source_embedding: row.embedding,
        p_user_id: row.user_id,
        match_threshold: 0.5,
        match_count: 5,
      });
      if (rpcErr) { console.log(`find_links failed for ${row.id}: ${rpcErr.message}`); continue; }

      let newHere = 0;
      for (const n of (neighbors ?? []) as { target_id: string; similarity: number }[]) {
        const { error: insErr } = await supabase.from('thought_links').insert({
          source_thought_id: row.id,
          target_thought_id: n.target_id,
          user_id: row.user_id,
          similarity_score: n.similarity,
          link_type: 'semantic',
        });
        if (!insErr) newHere++;
        else if (insErr.code !== '23505') console.log(`link insert failed: ${insErr.message}`);
      }
      linked += newHere;
      if (newHere === 0) alreadyDone++;
    }

    const processed = (rows ?? []).length;
    const offsetNext = offset + processed;
    const { count } = await supabase
      .from('thoughts')
      .select('id', { count: 'exact', head: true })
      .not('embedding', 'is', null);
    const remaining = Math.max((count ?? 0) - offsetNext, 0);

    return json({ processed, linked, already_done: alreadyDone, offset_next: offsetNext, remaining });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
