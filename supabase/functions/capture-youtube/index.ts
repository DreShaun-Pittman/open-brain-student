// ============================================================================
// CAPTURE-YOUTUBE
// ============================================================================
// Paste a YouTube link in Alfred's YouTube tab and this function fetches what
// was said in the video and saves it to your brain.
//
// WHY THIS FILE LOOKS COMPLICATED — worth reading before changing anything:
//
// YouTube serves a stripped-down page with no captions when the request comes
// from a datacentre, which is exactly what a Supabase edge function is. Code
// that works on your laptop fails once deployed. That is not a bug in your
// code; it is YouTube treating servers differently from people.
//
// So we try several routes and take the first one that works:
//
//   1. SUPADATA    — a service built for this. It fetches from home internet
//                    connections, so it gets real transcripts. Free tier covers
//                    about 100 videos a month. Optional: with no
//                    SUPADATA_API_KEY secret we skip straight to step 2.
//   2. INNERTUBE   — YouTube's own internal app API. We identify as the iPhone
//                    and Android apps, which YouTube often serves properly even
//                    from a datacentre. No key needed.
//   3. DESCRIPTION — if no captions are reachable, save the title and
//                    description instead, clearly labelled, so you still
//                    capture something.
//
// This version saves the text as-is. Summarising it with AI comes later in
// the course.
//
// Fetching logic adapted from Open Brain Express (capture-youtube). The save
// step matches what Alfred already does: a plain insert into thoughts, then
// the full transcript into thought_sources.
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

const MAX_CONTENT = 100_000

interface VideoContent {
  content: string
  hasTranscript: boolean
  source: 'supadata' | 'innertube' | 'description'
}

// ---------------------------------------------------------------------------
// HTML entities → characters. &amp; decodes last (see capture-url for why).
// ---------------------------------------------------------------------------
const NAMED: Record<string, string> = {
  nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…',
  iexcl: '¡', iquest: '¿', ntilde: 'ñ', Ntilde: 'Ñ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', uuml: 'ü', Uuml: 'Ü',
}
function decodeEntities(s: string): string {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name === 'amp' ? m : NAMED[name] ?? m))
    .replace(/&#(?!0*38;)(\d+);/g, (m, n) => {
      const c = Number(n)
      return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m
    })
    .replace(/&#x(?!0*26;)([0-9a-fA-F]+);/gi, (m, n) => {
      const c = parseInt(n, 16)
      return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m
    })
    .replace(/&amp;/g, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&')
}

// ---------------------------------------------------------------------------
// Pull the 11-character video id out of any YouTube link shape
// ---------------------------------------------------------------------------
function extractVideoId(input: string): string | null {
  const s = input.trim()
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s
  try {
    const u = new URL(s)
    const host = u.hostname.replace(/^(www|m|music)\./, '')
    if (host === 'youtu.be') return u.pathname.slice(1, 12) || null
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v')
      if (v) return v.slice(0, 11)
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/)
      if (m) return m[1]
    }
  } catch { /* not a URL */ }
  return null
}

// ---------------------------------------------------------------------------
// Title via oEmbed — lightweight, no key, almost always works
// ---------------------------------------------------------------------------
async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.title) return decodeEntities(String(data.title))
    }
  } catch { /* fall through */ }
  return `Video ${videoId}`
}

// ---------------------------------------------------------------------------
// ROUTE 1 — Supadata
// ---------------------------------------------------------------------------
async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  const key = (Deno.env.get('SUPADATA_API_KEY') ?? '').trim()
  if (!key) return null
  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
      { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(25_000) },
    )
    if (!res.ok) {
      // 402 here almost always means the free monthly quota is used up
      console.log(`[youtube] Supadata HTTP ${res.status} — falling through`)
      return null
    }
    const data = await res.json()
    // With text=true, content is one string. Without it, an array of segments.
    const raw = data?.content
    const transcript = (
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
        ? raw.map((s: { text?: string }) => s?.text ?? '').join(' ')
        : ''
    )
      .replace(/\s+/g, ' ')
      .trim()
    if (!transcript) {
      console.log('[youtube] Supadata returned no transcript — falling through')
      return null
    }
    console.log(`[youtube] Supadata OK — ${transcript.length} chars`)
    return { content: decodeEntities(transcript), hasTranscript: true, source: 'supadata' }
  } catch (err) {
    console.error('[youtube] Supadata error:', String(err))
    return null
  }
}

// ---------------------------------------------------------------------------
// ROUTE 2 (and 3) — Innertube, YouTube's internal app API.
// We pose as the iPhone app, then Android. Mobile apps often get a full caption
// list even from a datacentre. If no captions come back, fall back to the
// description from the same response.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
type Json = any

async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    {
      name: 'IOS',
      userAgent: 'com.google.ios.youtube/19.29.1 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      context: {
        clientName: 'IOS', clientVersion: '19.29.1',
        deviceMake: 'Apple', deviceModel: 'iPhone17,2',
        osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US',
      },
    },
    {
      name: 'ANDROID',
      userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      context: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' },
    },
  ]

  let best: Json = null

  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent },
        body: JSON.stringify({ context: { client: client.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.log(`[youtube] Innertube ${client.name} HTTP ${res.status}`)
        continue
      }
      const result: Json = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length > 0) {
        console.log(`[youtube] Innertube ${client.name}: ${tracks.length} caption tracks`)
        best = result
        break
      }
      // Keep the first response anyway — it still carries the description.
      if (!best) best = result
      console.log(`[youtube] Innertube ${client.name}: no caption tracks`)
    } catch (err) {
      console.error(`[youtube] Innertube ${client.name} error:`, String(err))
    }
  }

  if (!best) return null

  try {
    const tracks = best?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (Array.isArray(tracks) && tracks.length > 0) {
      // Prefer human-written English, then auto-generated English, then anything
      const track =
        tracks.find((t: Json) => t.languageCode === 'en' && t.kind !== 'asr') ??
        tracks.find((t: Json) => t.languageCode === 'en') ??
        tracks.find((t: Json) => String(t.languageCode ?? '').startsWith('en')) ??
        tracks[0]

      const capRes = await fetch(track.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(12_000),
      })
      if (capRes.ok) {
        const xml = await capRes.text()
        // Two caption formats exist: <text start=..>words</text> and
        // <p t=..><s>words</s></p>. Handle both.
        const pieces = [...xml.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g)]
          .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, '')))
        const transcript = pieces.join(' ').replace(/\s+/g, ' ').trim()
        if (transcript) {
          console.log(`[youtube] Innertube transcript OK — ${transcript.length} chars`)
          return { content: transcript, hasTranscript: true, source: 'innertube' }
        }
        console.log('[youtube] Innertube caption file was empty')
      } else {
        console.log(`[youtube] Innertube caption fetch HTTP ${capRes.status}`)
      }
    }

    // ROUTE 3 — no captions reachable. Use the description.
    const details = best?.videoDetails
    const description: string = details?.shortDescription ?? ''
    const keywords: string = Array.isArray(details?.keywords) ? details.keywords.join(', ') : ''
    if (description || keywords) {
      const content = [description, keywords ? `Keywords: ${keywords}` : ''].filter(Boolean).join('\n\n')
      console.log(`[youtube] Falling back to description — ${description.length} chars`)
      return { content, hasTranscript: false, source: 'description' }
    }
    return null
  } catch (err) {
    console.error('[youtube] Innertube parse error:', String(err))
    return null
  }
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405)

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } },
    )

    // Who is asking? Read from their login token, never from the request body —
    // otherwise anyone could write into anyone else's brain.
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: { user }, error: authError } = await admin.auth.getUser(jwt)
    if (authError || !user) return json({ ok: false, error: 'You are signed out. Sign in again.' }, 401)

    const { url } = await req.json().catch(() => ({}))
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A YouTube link is required.' }, 400)

    const videoId = extractVideoId(url)
    if (!videoId) {
      return json({
        ok: false,
        error: 'That does not look like a YouTube link. Expected something like https://www.youtube.com/watch?v=...',
      }, 400)
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    const title = await fetchTitle(videoUrl, videoId)

    // Try each route in order; first success wins
    const result = (await fromSupadata(videoUrl)) ?? (await fromInnertube(videoId))
    if (!result) {
      return json({
        ok: false,
        error: 'Could not read anything from that video. It may be private, age-restricted, or region-locked. Paste the transcript by hand below instead.',
      }, 422)
    }

    // --- Save: same shape Alfred's own YouTube tab uses ---------------------
    const label = result.hasTranscript
      ? ''
      : '(No transcript was available — this is the video description.)\n\n'
    const content = `📹 YouTube: ${title}\nhttps://youtu.be/${videoId}\n\n${label}${result.content}`.slice(0, MAX_CONTENT)

    const { data: thought, error: insertError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        metadata: {
          title,
          video_id: videoId,
          video_url: videoUrl,
          has_transcript: result.hasTranscript,
          fetched_via: result.source,
          source: 'capture-youtube',
        },
      })
      .select('id')
      .single()
    if (insertError) throw insertError

    // Full transcript (or description) into thought_sources. Non-fatal.
    const { error: srcError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: result.content,
      source_kind: result.hasTranscript ? 'youtube_transcript' : 'youtube_description',
      char_count: result.content.length,
      truncated: false,
    })
    if (srcError) console.warn('[youtube] thought_sources insert failed:', srcError.message)

    return json({
      ok: true,
      title,
      has_transcript: result.hasTranscript,
      fetched_via: result.source,
      chars: result.content.length,
    })
  } catch (err) {
    console.error('[youtube] Failed:', err)
    return json({ ok: false, error: String((err as { message?: string })?.message ?? err) }, 500)
  }
})
