// ============================================================================
// CAPTURE-URL
// ============================================================================
// Paste an article link in Alfred's URL tab and this function fetches the page,
// strips it down to readable text, and saves it to your brain.
//
// WHY THIS RUNS ON THE SERVER: a web page in your browser is not allowed to
// fetch pages from other websites (that rule is called CORS, and it exists for
// your security). A server has no such limit. So the browser hands the link to
// this function, and this function does the fetching.
//
// This version saves the extracted text as-is. Summarising it with AI comes
// later in the course, once you have an AI key set up.
//
// Fetching + text extraction adapted from Open Brain Express (capture-url and
// _shared/html-extract.ts). The save step matches what Alfred already does: a
// plain insert into thoughts, then the full text into thought_sources.
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

const MAX_BYTES = 3_000_000 // don't try to swallow a 50MB page
const MAX_CONTENT = 100_000 // cap on what goes into the thought itself

// ---------------------------------------------------------------------------
// HTML entities → characters (&rsquo; → ’ and so on). &amp; decodes last so a
// double-escaped "&amp;lt;" does not turn back into a real "<".
// ---------------------------------------------------------------------------
const NAMED: Record<string, string> = {
  nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£',
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
// HTML → readable text. Deliberately simple: drop scripts, menus, footers and
// so on, keep paragraph breaks, remove the remaining tags.
// ---------------------------------------------------------------------------
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : ''

  // If the page marks up its article properly, use just that part
  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return { title, text: cleaned }
}

// Refuse links that point at private/internal addresses
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') ||
    h === '0.0.0.0' || h === '::1' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)
  )
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405)

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } },
    )

    // Who is asking? Read from their login token, never from the request body.
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: { user }, error: authError } = await admin.auth.getUser(jwt)
    if (authError || !user) return json({ ok: false, error: 'You are signed out. Sign in again.' }, 401)

    const { url } = await req.json().catch(() => ({}))
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A link is required.' }, 400)

    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      return json({ ok: false, error: 'That is not a valid web address. Paste the full link, starting with https://' }, 400)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return json({ ok: false, error: 'Only http and https links are supported.' }, 400)
    }
    if (isPrivateHost(parsed.hostname)) {
      return json({ ok: false, error: 'That address is not a public web page.' }, 400)
    }

    // Fetch the page, identifying as a normal browser — some sites refuse
    // anything that looks automated.
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })

    if (!pageRes.ok) {
      return json({
        ok: false,
        error: `That page returned an error (HTTP ${pageRes.status}). It may need a login or block automated readers. Paste the text by hand below instead.`,
      }, 422)
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return json({
        ok: false,
        error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, download it and use the PDF tab.`,
      }, 415)
    }

    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) return json({ ok: false, error: 'That page is too large to process.' }, 413)

    const extracted = htmlToText(raw)
    const text = extracted.text
    const hostname = parsed.hostname.replace(/^www\./, '')
    const title = extracted.title || hostname

    if (text.length < 200) {
      return json({
        ok: false,
        error:
          'Almost no readable text was found. The page probably builds itself with JavaScript ' +
          'after loading, which a server cannot see. Paste the text by hand below instead.',
      }, 422)
    }

    // --- Save: same shape Alfred's own URL tab uses -------------------------
    const content = `🔗 Web: ${title}\n${parsed.toString()}\n\n${text}`.slice(0, MAX_CONTENT)
    const { data: thought, error: insertError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        metadata: { title, url: parsed.toString(), hostname, source: 'capture-url' },
      })
      .select('id')
      .single()
    if (insertError) throw insertError

    // Full text into thought_sources. Non-fatal: the thought is already saved.
    const { error: srcError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: text,
      source_kind: 'web',
      char_count: text.length,
      truncated: false,
    })
    if (srcError) console.warn('[url] thought_sources insert failed:', srcError.message)

    return json({ ok: true, title, hostname, chars: text.length })
  } catch (err) {
    console.error('[url] Failed:', err)
    const msg = String((err as { message?: string })?.message ?? err)
    return json({
      ok: false,
      error: /timed? ?out|abort/i.test(msg) ? 'That page took too long to respond.' : msg,
    }, 500)
  }
})
