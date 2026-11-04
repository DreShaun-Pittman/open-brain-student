// ============================================================================
// SEARCH-BRAIN
// ============================================================================
// The server side of the app's Search tab. Runs the same hybrid search Claude
// Desktop uses (meaning + keywords + chunks of long captures).
//
// WHY THIS RUNS ON THE SERVER: searching by meaning needs an embedding of the
// search phrase, and making one needs your AI key. That key can never sit in a
// web page, so the browser asks this function to do it.
//
// WHO IS ASKING: taken ONLY from the caller's own login token. A user id sent
// in the request body is never trusted, because a browser could put anything
// there. The search runs with the service role key (thought_chunks has no RLS
// policies on purpose), so p_user_id is the ONLY thing scoping it, and it is
// always the verified caller's id.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // 1. Who is asking? Verified from their own login token.
    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader) return json({ error: 'Not signed in' }, 401)
    const asCaller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })
    const { data: { user }, error: authError } = await asCaller.auth.getUser()
    if (authError || !user) return json({ error: 'Not signed in' }, 401)

    // 2. Read the request.
    const body = await req.json().catch(() => ({}))
    const query = String(body?.query ?? '').trim()
    if (!query) return json({ error: 'Please give a search query.' }, 400)
    const requested = Number(body?.limit)
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 50) : 20

    // 3. Embed the query. Any failure just means keyword-only search.
    let queryEmbedding: number[] | null = null
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ text: query }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && Array.isArray(data.embedding)) queryEmbedding = data.embedding
      else console.log(`[search-brain] no embedding (${res.status}); keyword-only search`)
    } catch (err) {
      console.log(`[search-brain] embedding call failed; keyword-only search: ${String(err)}`)
    }

    // 4. Hybrid search, scoped to the verified caller.
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
    const { data: results, error } = await admin.rpc('search_thoughts', {
      query_text: query,
      p_user_id: user.id,
      query_embedding: queryEmbedding,
      match_threshold: 0.3,
      match_count: limit,
    })
    if (error) return json({ error: error.message }, 500)

    return json({
      mode: queryEmbedding ? 'hybrid' : 'keyword-only',
      results: results ?? [],
    })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
