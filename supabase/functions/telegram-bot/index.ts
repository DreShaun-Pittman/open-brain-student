// =============================================================================
// telegram-bot — your brain's Telegram interface
//
// Telegram calls this function every time you message your bot.
//   /search word  or  ?word   → finds thoughts containing that word (top 5)
//   /recent                   → your last 5 thoughts
//   anything else             → saved as a new thought
//
// Secrets it reads (Supabase → Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN   from BotFather
//   OWNER_USER_ID        your account's UID — every saved thought belongs to it
//   TELEGRAM_CHAT_ID     your chat with the bot — the bot ignores everyone else
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Telegram only needs a 200 back. Anything else makes it retry the same message.
function ok(): Response {
  return new Response('ok', { status: 200, headers: corsHeaders })
}

async function reply(token: string, chatId: number, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Telegram's limit is 4096 characters per message
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
    })
    if (!res.ok) console.error('Telegram sendMessage failed:', await res.text())
  } catch (err) {
    console.error('Telegram sendMessage error:', err)
  }
}

type Thought = { content: string; created_at: string }

function formatThoughts(rows: Thought[]): string {
  return rows
    .map((t, i) => {
      const date = new Date(t.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
      const text = t.content.length > 300 ? t.content.slice(0, 300) + '…' : t.content
      return `${i + 1}. [${date}] ${text}`
    })
    .join('\n\n')
}

const HELP =
  'Send me any message and I will save it to your brain.\n\n' +
  '/search word  (or ?word) — find thoughts containing that word\n' +
  '/recent — your last 5 thoughts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return ok()

  const token = (Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '').trim()
  const ownerUserId = (Deno.env.get('OWNER_USER_ID') ?? '').trim()
  const allowedChatId = (Deno.env.get('TELEGRAM_CHAT_ID') ?? '').trim()
  const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim()
  const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim()

  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN secret is missing')
    return ok()
  }

  let chatId: number | undefined
  try {
    const update = await req.json()
    const message = update?.message
    if (!message?.chat?.id) return ok() // not a normal message (edits, joins, etc.)
    chatId = message.chat.id as number

    // --- Only you get in --------------------------------------------------
    // Until TELEGRAM_CHAT_ID is set, the bot just tells you your chat ID.
    if (!allowedChatId) {
      await reply(
        token,
        chatId,
        `Setup: your chat ID is ${chatId}\n\n` +
          'Add it in Supabase → Edge Functions → Secrets as TELEGRAM_CHAT_ID, then message me again. ' +
          'Nothing is saved until you do.',
      )
      return ok()
    }
    if (String(chatId) !== allowedChatId.trim()) {
      console.warn('Ignored message from unknown chat', chatId)
      return ok() // a stranger — say nothing
    }

    if (!ownerUserId) {
      await reply(token, chatId, 'OWNER_USER_ID secret is missing in Supabase. Add it and try again.')
      return ok()
    }

    const text: string = (message.text ?? '').trim()
    if (!text) {
      await reply(token, chatId, 'I can only save text messages for now.')
      return ok()
    }

    // The service role key skips your security rules, so every query below
    // sets or filters by your user_id itself.
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

    // --- /start or /help ----------------------------------------------------
    if (/^\/(start|help)(@\w+)?$/i.test(text)) {
      await reply(token, chatId, HELP)
      return ok()
    }

    // --- /search word  or  ?word ---------------------------------------------
    const searchMatch = text.match(/^\/search(@\w+)?\s*([\s\S]*)$/i) ?? text.match(/^\?()\s*([\s\S]*)$/)
    if (searchMatch) {
      const q = searchMatch[2].trim()
      if (!q) {
        await reply(token, chatId, 'Type a word after /search, like: /search accounting')
        return ok()
      }
      // Escape characters that have special meaning in a LIKE pattern
      const safe = q.replace(/[\\%_]/g, (ch) => '\\' + ch)
      const { data, error } = await admin
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', ownerUserId)
        .ilike('content', `%${safe}%`)
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error
      await reply(
        token,
        chatId,
        data && data.length
          ? `Top ${data.length} for "${q}":\n\n${formatThoughts(data)}`
          : `Nothing in your brain matches "${q}".`,
      )
      return ok()
    }

    // --- /recent ---------------------------------------------------------------
    if (/^\/recent(@\w+)?$/i.test(text)) {
      const { data, error } = await admin
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', ownerUserId)
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error
      await reply(
        token,
        chatId,
        data && data.length ? `Your last ${data.length} thoughts:\n\n${formatThoughts(data)}` : 'Your brain is empty so far.',
      )
      return ok()
    }

    // --- Unknown command: don't save typos like "/serch" as thoughts ----------
    if (text.startsWith('/')) {
      await reply(token, chatId, `I don't know that command.\n\n${HELP}`)
      return ok()
    }

    // --- Everything else: save it -----------------------------------------------
    const { error } = await admin.from('thoughts').insert({
      content: text,
      user_id: ownerUserId,
      metadata: { source: 'telegram', telegram_message_id: message.message_id },
    })
    if (error) throw error
    await reply(token, chatId, 'Saved to your brain 🧠')
    return ok()
  } catch (err) {
    console.error('telegram-bot error:', err)
    if (chatId) {
      const msg = (err as { message?: string })?.message ?? String(err)
      await reply(token, chatId, `Something went wrong: ${msg}`)
    }
    return ok() // always 200 so Telegram doesn't keep retrying
  }
})