// enrich-thought — the enrichment agent for Open Brain (Alfred)
//
// Triggered by a Supabase Database Webhook on every INSERT into `thoughts`.
// Adds tags, a category, and a one-sentence summary to the new thought,
// then stores its embedding (via generate-embedding) for semantic search.
//
// It never calls an AI provider directly. Every AI call goes through the
// call-llm gateway, so switching providers never touches this file.
//
// RULE: always return 200. A webhook function that fails just gets retried or
// logged as an error; it never helps. Problems are written to the logs instead.

import { createClient } from 'npm:@supabase/supabase-js@2';

const CATEGORIES = ['idea', 'learning', 'question', 'reference', 'plan', 'reflection'];
const MIN_LENGTH = 20;

const SYSTEM_PROMPT = `You organize notes in a personal knowledge base.
Reply with ONLY a JSON object, no other text, in exactly this shape:
{"tags": ["tag1", "tag2", "tag3"], "category": "learning", "summary": "One sentence."}

Rules:
- tags: 3 to 5 short lowercase tags, 1 to 3 words each
- category: exactly one of: ${CATEGORIES.join(', ')}
- summary: one sentence, at most 25 words`;

function ok(message: string): Response {
  console.log(message);
  return new Response(JSON.stringify({ ok: true, message }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Pull the first {...} block out of the model's reply, even if it added code fences or extra words.
function parseEnrichment(text: string): { tags: string[]; category: string | null; summary: string | null } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[0]);

    const tags = Array.isArray(data.tags)
      ? data.tags
          .filter((t: unknown) => typeof t === 'string' && t.trim())
          .map((t: string) => t.trim().toLowerCase())
          .slice(0, 5)
      : [];

    const rawCategory = typeof data.category === 'string' ? data.category.trim().toLowerCase() : '';
    const category = CATEGORIES.includes(rawCategory) ? rawCategory : null;

    const summary = typeof data.summary === 'string' && data.summary.trim() ? data.summary.trim() : null;

    return { tags, category, summary };
  } catch {
    return null;
  }
}

// Ask generate-embedding for this text's embedding (its "address" on the meaning map).
// The Authorization header is required: one function calling another must prove who
// it is, or the call is turned away with a 401 and embeddings silently never appear.
// Returns null on any failure so enrichment never crashes because of it.
async function getEmbedding(supabaseUrl: string, serviceKey: string, text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data.embedding)) {
      console.log(`generate-embedding returned no embedding (${res.status}): ${data.error ?? 'unknown error'}`);
      return null;
    }
    return data.embedding;
  } catch (err) {
    console.log(`generate-embedding call failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Tags, category, summary. Returns a log line describing what happened.
async function enrich(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  serviceKey: string,
  record: { id: string; content: string | null; category: string | null; enriched_at: string | null; user_id: string | null },
  content: string,
): Promise<string> {
  // Already enriched, or already has a category (for example a weekly digest Alfred wrote itself).
  if (record.enriched_at || record.category) return 'already enriched, skipped';
  if (content.length < MIN_LENGTH) return 'too short to enrich, skipped';

  // Call the gateway. The Authorization header is required: without it the gateway
  // turns this call away with a 401 and nothing gets enriched.
  const llmRes = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      systemPrompt: SYSTEM_PROMPT,
      prompt: `Note:\n"""\n${content.slice(0, 8000)}\n"""`,
      maxTokens: 300,
      userId: record.user_id ?? undefined, // who to bill this call to in llm_usage
      source: 'enrich-thought',
    }),
  });

  const llmData = await llmRes.json().catch(() => ({}));
  if (!llmRes.ok) return `call-llm failed (${llmRes.status}): ${JSON.stringify(llmData)}`;

  const enrichment = parseEnrichment(llmData.text ?? '');
  if (!enrichment) return `could not parse AI reply: ${llmData.text}`;

  const { error } = await supabase
    .from('thoughts')
    .update({
      tags: enrichment.tags,
      category: enrichment.category,
      summary: enrichment.summary,
      enriched_at: new Date().toISOString(),
    })
    .eq('id', record.id);

  if (error) return `database update failed: ${error.message}`;
  return `enriched: ${enrichment.category} [${enrichment.tags.join(', ')}]`;
}

// Finds up to 5 thoughts more than 50% similar and saves a link to each.
// A link that already exists (in EITHER direction) is skipped quietly: the
// database refuses it with a "duplicate" error (code 23505), which we ignore.
// Never throws; returns a log line.
async function autoLink(
  supabase: ReturnType<typeof createClient>,
  thoughtId: string,
  embedding: number[],
  userId: string,
): Promise<string> {
  const { data: neighbors, error } = await supabase.rpc('find_links_for_thought', {
    source_id: thoughtId,
    source_embedding: embedding,
    p_user_id: userId,
    match_threshold: 0.5,
    match_count: 5,
  });
  if (error) return `find_links failed: ${error.message}`;
  if (!neighbors || neighbors.length === 0) return 'no neighbors above 0.5';

  let linked = 0;
  for (const n of neighbors as { target_id: string; similarity: number }[]) {
    const { error: insErr } = await supabase.from('thought_links').insert({
      source_thought_id: thoughtId,
      target_thought_id: n.target_id,
      user_id: userId,
      similarity_score: n.similarity,
      link_type: 'semantic',
    });
    if (!insErr) linked++;
    else if (insErr.code !== '23505') console.log(`link insert failed: ${insErr.message}`);
  }
  return `linked to ${linked} of ${neighbors.length} neighbors`;
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json().catch(() => null);
    const recordId = payload?.record?.id;
    if (!recordId) return ok('No record in payload, skipping');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Read the thought from the database instead of trusting the incoming message.
    // This way a fake request can't make the agent spend money on made-up text,
    // and no thought ever gets enriched (and billed) twice.
    const { data: record, error: readError } = await supabase
      .from('thoughts')
      .select('id, content, category, enriched_at, user_id, embedding')
      .eq('id', recordId)
      .maybeSingle();
    if (readError) return ok(`Could not read thought ${recordId}: ${readError.message}`);
    if (!record) return ok(`Thought ${recordId} not found, skipping`);

    const content: string = (record.content ?? '').toString().trim();

    // 1. Enrichment (tags, category, summary). Its own skip rules live inside enrich().
    const enrichResult = await enrich(supabase, supabaseUrl, serviceKey, record, content);

    // 2. Embedding. Runs even when enrichment was skipped (a weekly digest, a short
    //    note), because every thought needs an address on the meaning map.
    let embedResult = 'already has an embedding, skipped';
    let newEmbedding: number[] | null = null;
    if (!record.embedding && content) {
      const embedding = await getEmbedding(supabaseUrl, serviceKey, content);
      if (embedding) {
        const { error: embError } = await supabase
          .from('thoughts')
          .update({ embedding })
          .eq('id', record.id);
        embedResult = embError ? `embedding save failed: ${embError.message}` : 'embedded';
        if (!embError) newEmbedding = embedding;
      } else {
        // The thought is still saved; backfill-embeddings can fill this in later.
        embedResult = 'no embedding (will be backfilled)';
      }
    }

    // 3. Auto-link: find this thought's nearest neighbors and save links to them.
    //    Scoped to the same user (p_user_id): this runs with the admin key, which
    //    skips row-level security, so without the filter it could link to other
    //    users' thoughts.
    let linkResult = 'no new embedding, linking skipped';
    if (newEmbedding && record.user_id) {
      linkResult = await autoLink(supabase, record.id, newEmbedding, record.user_id);
    }

    return ok(`Thought ${record.id}: ${enrichResult}; ${embedResult}; ${linkResult}`);
  } catch (err) {
    return ok(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
});
