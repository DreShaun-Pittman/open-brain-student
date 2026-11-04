// backfill-chunks — chunks long thoughts saved before Level 7
//
// POST { batch_size?: number, dry_run?: boolean }
//   dry_run: true -> { needs_chunks }  (writes nothing)
//   otherwise     -> { processed, chunked, remaining, stalled }
//   fill_missing: true -> embeds chunks that were saved WITHOUT an embedding
//                    -> { filled, failed, remaining, stalled, last_error }
//
// Works through the thoughts_needing_chunks view (from Step 1): thoughts over
// 2,000 characters with no chunks yet, BIGGEST FIRST, since those matter most
// if a run gets interrupted. A thought drops out of that view the moment its
// chunks exist, so running this again just picks up where it left off.
//
// stalled: true means a whole batch failed to chunk (check the function logs).
// The loop stops on it instead of retrying the same thoughts forever.
//
// Only you can run it: send your service role key or sb_secret_ key.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { saveThoughtChunksSafe, embedWithRetry } from '../_shared/thought-chunks.ts';

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
    const batchSize = Math.min(Math.max(Number(body?.batch_size) || 10, 1), 25);
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const countRemaining = async () => {
      const { count, error } = await supabase
        .from('thoughts_needing_chunks')
        .select('id', { count: 'exact', head: true });
      if (error) throw new Error(error.message);
      return count ?? 0;
    };

    if (body?.fill_missing === true) {
      const countMissing = async () => {
        const { count, error } = await supabase
          .from('thought_chunks').select('id', { count: 'exact', head: true }).is('embedding', null);
        if (error) throw new Error(error.message);
        return count ?? 0;
      };
      const { data: missing, error: mErr } = await supabase
        .from('thought_chunks').select('id, content').is('embedding', null)
        .order('created_at', { ascending: true }).limit(batchSize);
      if (mErr) return json({ error: mErr.message }, 500);
      let filled = 0;
      let failed = 0;
      let lastError: string | null = null;
      for (const c of missing ?? []) {
        const r = await embedWithRetry(String(c.content ?? ''));
        if (!r.embedding) { failed++; lastError = r.error; continue; }
        const { error: uErr } = await supabase.from('thought_chunks').update({ embedding: r.embedding }).eq('id', c.id);
        if (uErr) { failed++; lastError = uErr.message; } else filled++;
      }
      const remaining = await countMissing();
      return json({ filled, failed, remaining, stalled: (missing?.length ?? 0) > 0 && filled === 0, last_error: lastError });
    }

    if (body?.dry_run === true) {
      return json({ needs_chunks: await countRemaining() });
    }

    const { data: todo, error } = await supabase
      .from('thoughts_needing_chunks')
      .select('id, chars')
      .order('chars', { ascending: false })
      .limit(batchSize);
    if (error) return json({ error: error.message }, 500);

    let processed = 0;
    let chunked = 0;
    for (const row of todo ?? []) {
      processed++;
      const { data: thought, error: readErr } = await supabase
        .from('thoughts')
        .select('id, content, user_id')
        .eq('id', row.id)
        .maybeSingle();
      if (readErr || !thought) { console.log(`could not read ${row.id}: ${readErr?.message ?? 'not found'}`); continue; }

      const n = await saveThoughtChunksSafe(
        supabase, thought.id, String(thought.content ?? ''), 'backfill-chunks', 'summary', thought.user_id ?? undefined,
      );
      if (n > 0) chunked++;
      console.log(`${thought.id}: ${row.chars} chars -> ${n} chunks`);
    }

    const remaining = await countRemaining();
    return json({ processed, chunked, remaining, stalled: processed > 0 && chunked === 0 });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
