/**
 * Writes per-chunk embeddings for a thought that is already saved.
 *
 * The parent thought keeps its own whole-content embedding. Chunks are additive: search takes
 * the better of the document-level match and the best chunk-level match. So if chunking fails,
 * retrieval degrades to exactly the pre-chunking behaviour rather than breaking — which is why
 * callers use saveThoughtChunksSafe.
 *
 * Embeds one chunk at a time through this project's own generate-embedding edge function
 * (from Level 6) rather than a batch call. A capture is at most a few dozen chunks, so the
 * extra round trips cost seconds, not minutes.
 */

import { chunkText, shouldChunk } from './chunking.ts'

/** Which text a chunk was cut from. A thought can hold both: its own summary, and — for
 *  captures that have one — the full source text it was summarised from. */
export type ChunkOrigin = 'summary' | 'source'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Embeds one piece of text through generate-embedding, retrying up to 3 times with a growing
 * pause. generate-embedding answers 200 with { embedding: null, error } when OpenRouter refuses
 * (rate limit, low credits), so a missing embedding, not just a bad status, counts as a failure.
 */
export async function embedWithRetry(text: string): Promise<{ embedding: number[] | null; error: string | null }> {
  let lastError = 'unknown error'
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-embedding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
        body: JSON.stringify({ text }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && Array.isArray(data.embedding)) return { embedding: data.embedding, error: null }
      lastError = data.error ?? `generate-embedding returned ${res.status}`
    } catch (err) {
      lastError = String(err)
    }
    if (attempt < 3) await sleep(1000 * attempt * 2)
  }
  return { embedding: null, error: lastError }
}

/**
 * Replaces a thought's chunks FOR ONE ORIGIN. Throws on failure.
 * Returns the number of chunks written (0 when the content is too short to be worth chunking).
 *
 * The origin scoping is load-bearing: a thought can hold both summary chunks (from
 * thoughts.content) and source chunks (from thought_sources.source_text). Re-chunking one must
 * not delete the other.
 */
export async function saveThoughtChunks(
  supabase: any,
  thoughtId: string,
  content: string,
  origin: ChunkOrigin = 'summary',
  userId?: string,
): Promise<number> {
  if (!thoughtId || !shouldChunk(content)) return 0

  let chunks = chunkText(content)

  // chunkText declines content that collapses to a single core, because one chunk would just
  // duplicate the parent vector. For content over CHUNK_MIN_CONTENT that should be unreachable,
  // but fall back to one whole-content chunk rather than writing nothing if it ever happens.
  if (chunks.length === 0) {
    console.warn(`[thought-chunks] ${thoughtId}: ${content.length} chars produced no chunks; storing whole content as one chunk`)
    chunks = [{ index: 0, text: content, charStart: 0, charEnd: content.length }]
  }

  // One call per chunk to this project's own generate-embedding function (Level 6),
  // with retries. A chunk that still fails gets null instead of failing the capture.
  const embeddings: (number[] | null)[] = []
  for (const c of chunks) {
    const r = await embedWithRetry(c.text)
    if (!r.embedding) console.warn(`[thought-chunks] ${thoughtId}: chunk ${c.index} embedding failed: ${r.error}`)
    embeddings.push(r.embedding)
  }

  const rows = chunks.map((c, i) => ({
    thought_id: thoughtId,
    origin,
    chunk_index: c.index,
    content: c.text,
    char_start: c.charStart,
    char_end: c.charEnd,
    embedding: embeddings[i],
  }))

  // A chunk whose embedding call failed (rate limit, brief AI outage) is still written — the
  // embedding column is nullable, and the keyword arm of search does not require one. It is only
  // invisible to meaning-based search until the next re-chunk fills it in.
  const embedded = embeddings.filter((e) => e !== null).length
  if (embedded < chunks.length) {
    console.warn(`[thought-chunks] ${thoughtId}: ${embedded}/${chunks.length} chunks embedded — the rest are keyword-searchable only`)
  }

  // Delete-then-insert, not upsert: re-chunking content that got shorter must not leave stale
  // high-index chunks behind. Embeddings are generated before the delete so a failed API call
  // leaves the existing chunks untouched.
  const { error: delErr } = await supabase
    .from('thought_chunks').delete().eq('thought_id', thoughtId).eq('origin', origin)
  if (delErr) throw new Error(`chunk delete failed: ${delErr.message}`)

  const { error: insErr } = await supabase.from('thought_chunks').insert(rows)
  if (insErr) throw new Error(`chunk insert failed: ${insErr.message}`)

  return rows.length
}

/**
 * Same, but never throws. The thought is already committed by the time this runs; losing its
 * chunks costs retrieval granularity, whereas throwing here would fail a capture that succeeded.
 */
export async function saveThoughtChunksSafe(
  supabase: any,
  thoughtId: string,
  content: string,
  label: string,
  origin: ChunkOrigin = 'summary',
  userId?: string,
): Promise<number> {
  try {
    return await saveThoughtChunks(supabase, thoughtId, content, origin, userId)
  } catch (err) {
    console.error(`[${label}] ${origin} chunking failed (non-fatal):`, String(err))
    return 0
  }
}