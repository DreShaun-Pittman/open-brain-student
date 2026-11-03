// enrich-thought — the enrichment agent for Open Brain (Alfred)
//
// Triggered by a Supabase Database Webhook on every INSERT into `thoughts`.
// Adds tags, a category, and a one-sentence summary to the new thought.
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
      .select('id, content, category, enriched_at, user_id')
      .eq('id', recordId)
      .maybeSingle();
    if (readError) return ok(`Could not read thought ${recordId}: ${readError.message}`);
    if (!record) return ok(`Thought ${recordId} not found, skipping`);

    // Already enriched, or already has a category (for example a weekly digest Alfred wrote itself).
    if (record.enriched_at || record.category) return ok(`Thought ${record.id} is already enriched, skipping`);

    const content: string = (record.content ?? '').toString().trim();
    if (content.length < MIN_LENGTH) return ok(`Thought ${record.id} is too short to enrich, skipping`);

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
    if (!llmRes.ok) return ok(`call-llm failed (${llmRes.status}): ${JSON.stringify(llmData)}`);

    const enrichment = parseEnrichment(llmData.text ?? '');
    if (!enrichment) return ok(`Could not parse AI reply for thought ${record.id}: ${llmData.text}`);

    const { error } = await supabase
      .from('thoughts')
      .update({
        tags: enrichment.tags,
        category: enrichment.category,
        summary: enrichment.summary,
        enriched_at: new Date().toISOString(),
      })
      .eq('id', record.id);

    if (error) return ok(`Database update failed for thought ${record.id}: ${error.message}`);

    return ok(`Enriched thought ${record.id}: ${enrichment.category} [${enrichment.tags.join(', ')}]`);
  } catch (err) {
    return ok(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
});
