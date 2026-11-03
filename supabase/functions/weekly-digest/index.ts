// weekly-digest — Alfred's weekly report on your own mind
//
// Called every Sunday by pg_cron (and by you, any time, to test).
// Reads the last 7 days of thoughts, asks the AI for a digest through the
// call-llm gateway, and saves the result as a new thought with category 'digest'.
//
// It never calls an AI provider directly. Every AI call goes through call-llm.
//
// Built-in protection: it only writes one digest every 2 days, so nobody can
// run up your AI bill by calling this URL over and over (and a test run during
// the week never blocks Sunday's real one). To force another one
// while testing, send {"force": true} with your service role key.

import { createClient } from 'npm:@supabase/supabase-js@2';

const MIN_THOUGHTS = 5;
const MAX_THOUGHTS = 300;
const MAX_CHARS_PER_THOUGHT = 600;
const MAX_TOTAL_CHARS = 100_000;
const TIMEZONE = Deno.env.get('DIGEST_TIMEZONE') ?? 'America/Phoenix';

const SYSTEM_PROMPT = `You write a weekly digest of one person's personal notes, addressed to them as "you".
Use only what is in the notes. Do not invent facts, people, or events.
Write plain text (simple dashes for bullets, no tables, no bold), under 400 words, in exactly these three sections:

WHAT YOU WERE LEARNING
- 3 to 6 bullets, each one a topic plus a sentence on what you took away

KEY THEMES
- 2 to 4 bullets on patterns that connect several notes

A QUESTION YOU SEEM TO BE EXPLORING
One question in your own words, then one sentence on which notes point to it.`;

function ok(message: string): Response {
  console.log(message);
  return new Response(JSON.stringify({ ok: true, message }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shortDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TIMEZONE });
}

Deno.serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const body = await req.json().catch(() => ({}));
    const isOwner = req.headers.get('Authorization') === `Bearer ${serviceKey}`;
    const force = body?.force === true && isOwner;

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

    // One digest per week, unless the owner forces a test run.
    if (!force) {
      const { data: recent } = await supabase
        .from('thoughts')
        .select('id')
        .eq('category', 'digest')
        .gte('created_at', twoDaysAgo.toISOString())
        .limit(1);
      if (recent && recent.length) return ok('A digest was already written in the last 2 days, skipping');
    }

    const { data: rows, error } = await supabase
      .from('thoughts')
      .select('content, summary, category, user_id, created_at')
      .gte('created_at', weekAgo.toISOString())
      .or('category.is.null,category.neq.digest')
      .order('created_at', { ascending: true })
      .limit(MAX_THOUGHTS);
    if (error) return ok(`Could not read thoughts: ${error.message}`);

    const thoughts = (rows ?? []).filter((t) => (t.content ?? '').trim());
    if (thoughts.length < MIN_THOUGHTS) {
      return ok(`Only ${thoughts.length} thoughts this week (need ${MIN_THOUGHTS}), skipping`);
    }

    // The digest belongs to whoever owns most of this week's thoughts (you).
    const counts = new Map<string, number>();
    for (const t of thoughts) if (t.user_id) counts.set(t.user_id, (counts.get(t.user_id) ?? 0) + 1);
    const userId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!userId) return ok('None of this week\'s thoughts have a user_id, skipping');

    // Group by category so the AI sees the shape of the week.
    const groups = new Map<string, string[]>();
    let total = 0;
    for (const t of thoughts.filter((t) => t.user_id === userId)) {
      const text = (t.summary?.trim() ? `${t.summary.trim()} | ` : '') + t.content.trim().slice(0, MAX_CHARS_PER_THOUGHT);
      const line = `- (${shortDate(new Date(t.created_at))}) ${text.replace(/\s+/g, ' ')}`;
      if (total + line.length > MAX_TOTAL_CHARS) break;
      total += line.length;
      const key = t.category ?? 'uncategorized';
      groups.set(key, [...(groups.get(key) ?? []), line]);
    }
    const notes = [...groups.entries()].map(([cat, lines]) => `## ${cat}\n${lines.join('\n')}`).join('\n\n');
    const used = [...groups.values()].reduce((n, l) => n + l.length, 0);

    // Call the gateway. The Authorization header is required, or call-llm refuses.
    const llmRes = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        systemPrompt: SYSTEM_PROMPT,
        prompt: `Here are my notes from ${shortDate(weekAgo)} to ${shortDate(now)}, grouped by category:\n\n${notes}`,
        maxTokens: 1200,
        userId,
        source: 'weekly-digest',
      }),
    });
    const llmData = await llmRes.json().catch(() => ({}));
    if (!llmRes.ok || !llmData.text) return ok(`call-llm failed (${llmRes.status}): ${JSON.stringify(llmData)}`);

    const title = `Weekly digest: ${shortDate(weekAgo)} to ${shortDate(now)}`;
    const { error: insertError } = await supabase.from('thoughts').insert({
      user_id: userId,
      content: `${title}\n\n${llmData.text.trim()}`,
      category: 'digest',
      tags: ['weekly digest'],
      summary: `${title}, covering ${used} thoughts`,
      enriched_at: now.toISOString(),
      metadata: { source: 'weekly-digest', thought_count: used },
    });
    if (insertError) return ok(`Could not save the digest: ${insertError.message}`);

    return ok(`Saved ${title} (${used} thoughts)`);
  } catch (err) {
    return ok(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
});
