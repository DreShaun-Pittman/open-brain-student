// backfill-embeddings — gives every older thought an embedding, a few at a time
//
// POST { batch_size?: number, offset?: number }
//   -> { processed, embedded, failed, offset_next, remaining }
//
// Picks thoughts where embedding IS NULL, oldest first. Embedded thoughts drop
// out of that list on their own, so `offset` only moves forward past thoughts
// that FAILED (otherwise the next batch would retry the same broken row forever).
// Run it in a loop until remaining = 0 (see scripts/backfill.sh).
//
// Only you can run it: send your service role key, same rule as call-llm.

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
    const batchSize = Math.min(Math.max(Number(body?.batch_size) || 5, 1), 20);
    const offset = Math.max(Number(body?.offset) || 0, 0);

    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: rows, error } = await supabase
      .from('thoughts')
      .select('id, content')
      .is('embedding', null)
      .order('created_at', { ascending: true })
      .range(offset, offset + batchSize - 1);
    if (error) return json({ error: error.message }, 500);

    let embedded = 0;
    let failed = 0;

    for (const row of rows ?? []) {
      try {
        const text = (row.content ?? '').toString().trim();
        if (!text) { failed++; continue; }

        const res = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
          body: JSON.stringify({ text }),
        });
        const data = await res.json().catch(() => ({}));
        if (!Array.isArray(data.embedding)) {
          console.log(`No embedding for ${row.id}: ${data.error ?? res.status}`);
          failed++;
          continue;
        }

        const { error: upErr } = await supabase
          .from('thoughts')
          .update({ embedding: data.embedding })
          .eq('id', row.id);
        if (upErr) {
          console.log(`Save failed for ${row.id}: ${upErr.message}`);
          failed++;
        } else {
          embedded++;
        }
      } catch (err) {
        console.log(`Error on ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }

    const offsetNext = offset + failed;
    const { count } = await supabase
      .from('thoughts')
      .select('id', { count: 'exact', head: true })
      .is('embedding', null);
    const remaining = Math.max((count ?? 0) - offsetNext, 0);

    return json({
      processed: (rows ?? []).length,
      embedded,
      failed,
      offset_next: offsetNext,
      remaining,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
