// generate-embedding — turns text into an embedding (its "address" on the meaning map)
//
// POST { text: string }  ->  { embedding: number[] }   (1,536 numbers)
// On any failure it returns { embedding: null } so the caller can keep going
// without crashing. A thought without an embedding can be backfilled later.
//
// Goes through OpenRouter, which routes to any embedding provider with one key.
//
// To switch embedding providers, change the model string. The vector dimension
// must stay 1536 or you need a new migration.
//
// Only your own functions may call this (it spends your OpenRouter credits).
// They prove it by sending your service role key, same rule as call-llm.

const MODEL = 'openai/text-embedding-3-small';
const DIMENSIONS = 1536;
const TIMEOUT_MS = 15_000;
const MAX_CHARS = 24_000; // ~6,000 words; keeps long transcripts under the model's input limit

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ embedding: null, error: 'Use POST' }, 405);

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!serviceKey || req.headers.get('Authorization') !== `Bearer ${serviceKey}`) {
    return json({ embedding: null, error: 'Unauthorized' }, 401);
  }

  try {
    const body = await req.json().catch(() => null);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return json({ embedding: null, error: 'text is required' });

    // .trim() removes invisible spaces or line breaks pasted into a secret by accident.
    const apiKey = (Deno.env.get('OPENROUTER_API_KEY') ?? '').trim();
    if (!apiKey) {
      console.error('OPENROUTER_API_KEY is not set');
      return json({ embedding: null, error: 'OPENROUTER_API_KEY is not set' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: MODEL, input: text.slice(0, MAX_CHARS) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`OpenRouter error ${res.status}: ${JSON.stringify(data)}`);
      return json({ embedding: null, error: `OpenRouter error ${res.status}` });
    }

    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== DIMENSIONS) {
      console.error(`Unexpected embedding shape: length ${Array.isArray(embedding) ? embedding.length : 'none'}`);
      return json({ embedding: null, error: 'Unexpected embedding shape' });
    }

    return json({ embedding });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`generate-embedding failed: ${msg}`);
    return json({ embedding: null, error: msg });
  }
});
