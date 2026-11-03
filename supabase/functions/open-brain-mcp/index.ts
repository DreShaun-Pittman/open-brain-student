// ============================================================
// open-brain-mcp: the MCP server for your brain (Alfred)
//
// What this does: lets any MCP-compatible AI (Claude Desktop today,
// any other MCP app tomorrow) search, list and add to your thoughts.
// The AI talks to THIS function. This function talks to your database.
// The AI never sees your database keys.
//
// Deploy with:
//   npx supabase functions deploy open-brain-mcp --no-verify-jwt
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ------------------------------------------------------------
// 1. SETTINGS
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are handed to every
// edge function automatically by Supabase. You never set them.
// MCP_ACCESS_KEY is the password you created in Step 2.
// ------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? "";

// Optional: add a secret called BRAIN_USER_ID to stamp new thoughts with
// your user id. If you don't, the server copies the user id from your
// most recent thought, so new thoughts still show up in your app.
const BRAIN_USER_ID = Deno.env.get("BRAIN_USER_ID") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const SERVER_INFO = { name: "open-brain", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

// Long YouTube transcripts and PDFs get cut to this many characters in
// search/list results so Claude isn't flooded. get_thought returns the
// full text of any single thought.
const PREVIEW_CHARS = 1500;

// ------------------------------------------------------------
// 2. CORS HEADERS
// Lets browser-based MCP clients call this function too.
// ------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, accept, mcp-session-id, mcp-protocol-version",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ------------------------------------------------------------
// 3. THE TOOL LIST
// This is the "menu" the AI reads. Each tool has a name, a plain-English
// description (the AI uses this to decide when to call it), and the
// inputs it accepts.
// ------------------------------------------------------------
const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Search Dre's personal brain (notes, YouTube transcripts, PDF lecture slides, Telegram messages) by MEANING, not just exact words: 'how to get new clients' also finds notes about customer acquisition. Returns up to 10 matches, most similar first, each with a similarity score (0 to 1). Natural phrases and questions work well. Each result also lists 'connected' thoughts from Dre's thought graph (related ideas linked automatically); mention useful connections to Dre. Falls back to keyword matching if semantic search is unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description: "List the most recent thoughts saved to Dre's brain, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many thoughts to return (default 10, max 50)",
        },
      },
    },
  },
  {
    name: "get_thought",
    description:
      "Get the FULL text of one thought by its id. Use this when a search result was cut off and you need the whole transcript or document.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The thought's id (a uuid)" },
      },
      required: ["id"],
    },
  },
  {
    name: "add_thought",
    description: "Save a new thought to Dre's brain.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The text to save" },
      },
      required: ["content"],
    },
  },
];

// ------------------------------------------------------------
// 4. TOOL LOGIC
// Each function below does the actual database work for one tool.
// ------------------------------------------------------------
type Thought = { id: string; content: string; created_at: string };

// Shortens long thoughts and labels them so the AI knows to call get_thought.
function preview(rows: Thought[]) {
  return rows.map((t) => {
    const long = t.content.length > PREVIEW_CHARS;
    return {
      id: t.id,
      created_at: t.created_at,
      content: long ? t.content.slice(0, PREVIEW_CHARS) + " …" : t.content,
      ...(long ? { truncated: true, full_length: t.content.length } : {}),
    };
  });
}

// Turns text into an embedding through the generate-embedding function.
// Returns null on any failure so search can fall back to keywords.
async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data.embedding) ? data.embedding : null;
  } catch {
    return null;
  }
}

// The thought graph: for each id, the thoughts linked to it (either direction),
// strongest link first, with a short preview. Never throws: on any error the
// search still returns, just without connections.
const LINK_PREVIEW_CHARS = 200;
async function linkedThoughts(ids: string[]) {
  const out = new Map<string, { id: string; link_strength: number; preview: string }[]>();
  if (ids.length === 0) return out;
  try {
    const list = ids.join(",");
    const { data: links, error } = await supabase
      .from("thought_links")
      .select("source_thought_id, target_thought_id, similarity_score")
      .or(`source_thought_id.in.(${list}),target_thought_id.in.(${list})`)
      .order("similarity_score", { ascending: false })
      .limit(200);
    if (error || !links) return out;

    const otherIds = new Set<string>();
    for (const l of links) {
      otherIds.add(l.source_thought_id);
      otherIds.add(l.target_thought_id);
    }
    const { data: others } = await supabase
      .from("thoughts")
      .select("id, content")
      .in("id", [...otherIds]);
    const text = new Map((others ?? []).map((t) => [t.id, String(t.content ?? "")]));

    for (const id of ids) {
      const mine = links
        .filter((l) => l.source_thought_id === id || l.target_thought_id === id)
        .slice(0, 5)
        .map((l) => {
          const other = l.source_thought_id === id ? l.target_thought_id : l.source_thought_id;
          const c = text.get(other) ?? "";
          return {
            id: other,
            link_strength: Math.round(l.similarity_score * 1000) / 1000,
            preview: c.length > LINK_PREVIEW_CHARS ? c.slice(0, LINK_PREVIEW_CHARS) + " …" : c,
          };
        });
      out.set(id, mine);
    }
  } catch {
    // ignore: connections are a bonus, never a reason for search to fail
  }
  return out;
}

// Semantic search: compare the MEANING of the query to every thought's embedding.
// If that can't run (embedding failed) or finds nothing, fall back to keywords.
async function searchThoughts(query: string) {
  const text = String(query ?? "").trim();
  if (!text) throw new Error("Please give a search query.");

  const queryEmbedding = await embed(text);
  if (queryEmbedding) {
    const { data, error } = await supabase.rpc("search_thoughts", {
      query_embedding: queryEmbedding,
      match_threshold: 0.3,
      match_count: 10,
    });
    if (error) throw new Error(error.message);
    if (data && data.length > 0) {
      const rows = data as (Thought & { similarity: number })[];
      const previews = preview(rows);
      const connected = await linkedThoughts(rows.map((r) => r.id));
      return {
        match: "semantic (by meaning)",
        note: "Each result lists 'connected' thoughts from the thought graph: related ideas linked automatically by meaning, even if they didn't match the search itself.",
        results: previews.map((p, i) => ({
          ...p,
          similarity: Math.round(rows[i].similarity * 1000) / 1000,
          connected: connected.get(rows[i].id) ?? [],
        })),
      };
    }
  }

  const kw = await keywordSearch(text);
  return { ...kw, match: `keyword fallback: ${kw.match}` };
}

async function keywordSearch(query: string) {
  // Break the query into clean words. Strip symbols that would confuse the database filter.
  const words = String(query ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ""))
    .filter((w) => w.length > 0)
    .slice(0, 6);
  if (words.length === 0) throw new Error("Please give a search query.");

  // First try: thoughts containing ALL the words.
  let q = supabase.from("thoughts").select("id, content, created_at");
  for (const w of words) q = q.ilike("content", `%${w}%`);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(10);
  if (error) throw new Error(error.message);
  if (data && data.length > 0) return { match: "all words", results: preview(data) };

  // Second try: thoughts containing ANY of the words.
  if (words.length > 1) {
    const anyFilter = words.map((w) => `content.ilike.%${w}%`).join(",");
    const { data: d2, error: e2 } = await supabase
      .from("thoughts")
      .select("id, content, created_at")
      .or(anyFilter)
      .order("created_at", { ascending: false })
      .limit(10);
    if (e2) throw new Error(e2.message);
    return { match: "any word", results: preview(d2 ?? []) };
  }
  return { match: "none", results: [] };
}

async function listRecent(limit?: number) {
  const n = Math.min(Math.max(Math.floor(Number(limit) || 10), 1), 50);
  const { data, error } = await supabase
    .from("thoughts")
    .select("id, content, created_at")
    .order("created_at", { ascending: false })
    .limit(n);
  if (error) throw new Error(error.message);
  return { results: preview(data ?? []) };
}

async function getThought(id: string) {
  const { data, error } = await supabase
    .from("thoughts")
    .select("id, content, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No thought found with id ${id}`);
  return data;
}

async function addThought(content: string) {
  const text = String(content ?? "").trim();
  if (!text) throw new Error("Content can't be empty.");

  // Work out whose brain this belongs to, so the thought appears in your app.
  let userId: string | null = BRAIN_USER_ID || null;
  if (!userId) {
    const { data } = await supabase
      .from("thoughts")
      .select("user_id")
      .not("user_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    userId = data?.user_id ?? null;
  }

  const { data, error } = await supabase
    .from("thoughts")
    .upsert({ content: text, user_id: userId, metadata: { source: "mcp" } }, { onConflict: "dedup_key,user_id", ignoreDuplicates: false })
    .select("id, content, created_at")
    .single();
  if (error) throw new Error(error.message);
  return { saved: data };
}

// Runs whichever tool the AI asked for.
async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "search_thoughts":
      return await searchThoughts(args.query as string);
    case "list_recent":
      return await listRecent(args.limit as number);
    case "get_thought":
      return await getThought(args.id as string);
    case "add_thought":
      return await addThought(args.content as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ------------------------------------------------------------
// 5. JSON-RPC HANDLER
// MCP messages use a format called JSON-RPC 2.0: every request has a
// "method" (what to do) and an "id" (so the answer can be matched to
// the question). This function answers one message.
// ------------------------------------------------------------
type RpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

async function handleMessage(msg: RpcMessage) {
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: { code, message },
  });

  // Notifications ("initialized", "cancelled") need no answer.
  if (isNotification) return null;

  switch (msg.method) {
    // The AI says hello and both sides agree on a protocol version.
    case "initialize":
      return reply({
        protocolVersion: (msg.params?.protocolVersion as string) ?? DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "This server is Dre's personal knowledge base (Open Brain / Alfred). Search it whenever a question might relate to something Dre has saved: his classes, trading, videos he watched, plans and notes.",
      });

    case "ping":
      return reply({});

    // The AI asks: what tools do you have?
    case "tools/list":
      return reply({ tools: TOOLS });

    // The AI uses a tool.
    case "tools/call": {
      const name = msg.params?.name as string;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await callTool(name, args);
        return reply({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        // Tool errors go back to the AI as readable text so it can explain or retry.
        return reply({
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        });
      }
    }

    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

// ------------------------------------------------------------
// 6. THE FRONT DOOR
// Every request lands here. Order: CORS check → password check →
// read the message(s) → answer.
// ------------------------------------------------------------
Deno.serve(async (req) => {
  // Browsers send an OPTIONS "pre-flight" request first. Just say OK.
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Password check: the Authorization header must be "Bearer <MCP_ACCESS_KEY>".
  const auth = req.headers.get("authorization") ?? "";
  if (!MCP_ACCESS_KEY || auth !== `Bearer ${MCP_ACCESS_KEY}`) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, 401);
  }

  // This server only answers POST. (GET would open a live stream, which we don't need.)
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...CORS, Allow: "POST, OPTIONS" },
    });
  }

  let body: RpcMessage | RpcMessage[];
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  // A request can be one message or a list of messages.
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map(handleMessage))).filter((a) => a !== null);
    if (answers.length === 0) return new Response(null, { status: 202, headers: CORS });
    return json(answers);
  }

  const answer = await handleMessage(body);
  if (answer === null) return new Response(null, { status: 202, headers: CORS });
  return json(answer);
});
