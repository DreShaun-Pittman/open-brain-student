// call-llm — the LLM gateway for Open Brain (Alfred)
//
// To switch providers, change LLM_PROVIDER in Supabase secrets. Add the new provider's API key. No other code changes needed.
//
// Secrets this function reads (Supabase → Edge Functions → Secrets):
//   LLM_PROVIDER       'anthropic' (default) or 'openai'
//   LLM_MODEL          the model name for that provider
//   ANTHROPIC_API_KEY  needed when LLM_PROVIDER = anthropic
//   OPENAI_API_KEY     needed when LLM_PROVIDER = openai
//   OPENAI_BASE_URL    optional — any OpenAI-compatible service (OpenRouter, Groq, a local Ollama, etc.)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by Supabase.
//
// Request body:  { prompt, systemPrompt?, model?, maxTokens?, userId?, source? }
// Response body: { text }

import { createClient } from 'npm:@supabase/supabase-js@2';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

type LlmResult = { text: string; promptTokens: number; completionTokens: number };

// Published prices in USD per 1 million tokens. Used only to estimate cost_usd for your receipt table.
// A model not listed here is logged with a cost of 0. Update this if you change models or prices change.
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  if (!key) return 0;
  const p = PRICES[key];
  return (promptTokens * p.input + completionTokens * p.output) / 1_000_000;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readJson(res: Response): Promise<any> {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

// ── Provider: Anthropic ────────────────────────────────────────────────
async function callAnthropic(
  prompt: string,
  systemPrompt: string | undefined,
  model: string,
  maxTokens: number,
): Promise<LlmResult> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in Supabase secrets');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(`Anthropic error ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
  }

  const text = (data.content ?? [])
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('');

  return {
    text,
    promptTokens: data.usage?.input_tokens ?? 0,
    completionTokens: data.usage?.output_tokens ?? 0,
  };
}

// ── Provider: OpenAI (or any OpenAI-compatible service) ────────────────
async function callOpenAI(
  prompt: string,
  systemPrompt: string | undefined,
  model: string,
  maxTokens: number,
): Promise<LlmResult> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set in Supabase secrets');
  const baseUrl = (Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/$/, '');

  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    { role: 'user', content: prompt },
  ];

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
  });

  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`);
  }

  return {
    text: data.choices?.[0]?.message?.content ?? '',
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

// ── Receipt: log every call to llm_usage ───────────────────────────────
// RULE: a failed log must never fail the call that triggered it. The AI already answered.
async function logUsage(row: {
  userId?: string;
  source?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}): Promise<void> {
  try {
    if (!row.userId) return; // llm_usage requires a user to bill; skip quietly
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return;

    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { error } = await supabase.from('llm_usage').insert({
      user_id: row.userId,
      kind: 'chat',
      model: row.model,
      source: row.source ?? null,
      prompt_tokens: row.promptTokens,
      completion_tokens: row.completionTokens,
      cost_usd: estimateCost(row.model, row.promptTokens, row.completionTokens),
    });
    if (error) console.warn('usage log skipped:', error.message);
  } catch (err) {
    console.warn('usage log skipped:', err);
  }
}

// ── The gateway ────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  // Only your own functions may spend your AI credits. They prove it by sending
  // your service role key, which never leaves Supabase. Anyone else is refused.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!serviceKey || req.headers.get('Authorization') !== `Bearer ${serviceKey}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Request body must be JSON' }, 400);
  }

  const { prompt, systemPrompt, model: modelOverride, maxTokens = 1024, userId, source } = body ?? {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return json({ error: 'prompt is required' }, 400);
  }

  // .trim() removes invisible spaces or line breaks pasted into a secret by accident.
  const provider = (Deno.env.get('LLM_PROVIDER') ?? 'anthropic').trim().toLowerCase();
  const model: string | undefined = (modelOverride ?? Deno.env.get('LLM_MODEL'))?.trim() || undefined;
  if (!model) return json({ error: 'LLM_MODEL is not set in Supabase secrets' }, 500);

  try {
    let result: LlmResult;
    switch (provider) {
      case 'anthropic':
        result = await callAnthropic(prompt, systemPrompt, model, maxTokens);
        break;
      case 'openai':
        result = await callOpenAI(prompt, systemPrompt, model, maxTokens);
        break;
      default:
        return json({ error: `Unknown LLM_PROVIDER: ${provider}` }, 500);
    }

    // Fire-and-forget the receipt. Not awaited, errors swallowed.
    const logging = logUsage({
      userId,
      source,
      model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    }).catch(() => {});
    // Lets the log finish in the background after the response is sent.
    if (typeof EdgeRuntime !== 'undefined') {
      try {
        EdgeRuntime.waitUntil(logging);
      } catch {
        // ignore
      }
    }

    return json({ text: result.text });
  } catch (err) {
    console.error('call-llm failed:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
