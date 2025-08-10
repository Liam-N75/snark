// api/snark.js
// Notion-aware quip bot using OpenRouter (chat/completions).
// If OpenRouter fails, returns explicit error JSON (no canned lines).
//
// ENV VARS (Vercel → Project → Settings → Environment Variables)
//
// Notion (required):
// - NOTION_TOKEN
// - NOTION_DB_ID
// - NOTION_TITLE_PROP = "Classes:"
// - NOTION_DUE_PROP   = "Date"
// - NOTION_CLASS_MAP  = "S-A:NYP_1,C-A:Conflict_of_Laws,E-A:Evidence,SC-A:State_and_Local_Tax,N-A:Supreme_Court_Watch"
//   (underscores become spaces)
//
// OpenRouter (required to use LLM):
// - OPENROUTER_API_KEY
// - OPENROUTER_MODEL  (e.g., "openai/gpt-5")
// Optional but nice to have for OpenRouter analytics:
// - OPENROUTER_SITE_URL  (e.g., "https://your-app.vercel.app")
// - OPENROUTER_APP_NAME  (e.g., "Daily Snark")
//
// Debug: append ?debug=1 to see origin and errors.

const NOTION_VERSION = "2022-06-28";
const TIMEOUT_MS = 9000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

// ---------- Notion helpers ----------
function parseClassMap() {
  const raw = process.env.NOTION_CLASS_MAP || "";
  return raw
    .split(",")
    .map(pair => pair.trim())
    .filter(Boolean)
    .map(pair => {
      const [checkbox, textProp] = pair.split(":").map(s => (s || "").trim());
      if (!checkbox || !textProp) return null;
      return {
        checkbox: checkbox.replace(/_/g, " "),
        textProp: textProp.replace(/_/g, " "),
      };
    })
    .filter(Boolean);
}

async function notionQuery(dbId, headers, body) {
  const url = `https://api.notion.com/v1/databases/${dbId}/query`;
  const res = await withTimeout(fetch(url, { method: "POST", headers, body: JSON.stringify(body) }));
  return res.json();
}

async function fetchContextFromNotion() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ID;
  if (!token || !dbId) {
    return { perClass: [], doneApprox: 0, reason: "missing_notion_env" };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  const DUE = process.env.NOTION_DUE_PROP || "Date";
  const TITLE = process.env.NOTION_TITLE_PROP || "Name";
  const classMap = parseClassMap();

  // Done approx = any mapped checkbox true
  let doneApprox = 0;
  if (classMap.length) {
    const orFilter = classMap.length === 1
      ? { property: classMap[0].checkbox, checkbox: { equals: true } }
      : { or: classMap.map(({ checkbox }) => ({ property: checkbox, checkbox: { equals: true } })) };
    try {
      const doneResp = await notionQuery(dbId, headers, { filter: orFilter, page_size: 100 });
      if (doneResp && doneResp.object !== "error") {
        doneApprox = (doneResp.results || []).length;
      }
    } catch {}
  }

  // Pending per class = checkbox false (prefer class text; fallback to title; final label uses class name)
  const perClass = [];
  for (const { checkbox, textProp } of classMap) {
    try {
      const sorts = DUE ? [{ property: DUE, direction: "ascending" }] : undefined;
      const resp = await notionQuery(dbId, headers, {
        filter: { property: checkbox, checkbox: { equals: false } },
        page_size: 5,
        sorts,
      });
      if (!resp || resp.object === "error") continue;

      const items = (resp.results || []).map(page => {
        const rt = page.properties?.[textProp]?.rich_text || [];
        let name = rt.map(t => t.plain_text).join("").trim();

        if (!name) {
          const titleArr = page.properties?.[TITLE]?.title || [];
          name = titleArr.map(t => t.plain_text).join("").trim();
        }
        if (!name) {
          name = textProp;
          const dueProp = page.properties?.[DUE];
          if (dueProp?.type === "date" && dueProp.date?.start) {
            name += ` assignment (${dueProp.date.start.slice(0,10)})`;
          } else {
            name += " assignment";
          }
        }

        let dueIso = null;
        const due = page.properties?.[DUE];
        if (due?.type === "date" && due.date?.start) dueIso = due.date.start;

        return { name, dueIso };
      });

      if (items.length) perClass.push({ className: textProp, items });
    } catch {}
  }

  return { perClass, doneApprox, reason: perClass.length ? "ok" : "notion_empty_or_mismatch" };
}

// ---------- OpenRouter call ----------
async function callOpenRouter({ system, context }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model  = process.env.OPENROUTER_MODEL || "openai/gpt-5"; // your target
  if (!apiKey) {
    return { snark: null, error: "Missing OPENROUTER_API_KEY" };
  }

  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  // Optional analytics headers (recommended by OpenRouter)
  if (process.env.OPENROUTER_SITE_URL) headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
  if (process.env.OPENROUTER_APP_NAME) headers["X-Title"] = process.env.OPENROUTER_APP_NAME;

  const nonce = Math.random().toString(36).slice(2, 8);
  const body = {
    model,
    messages: [
      {
        role: "system",
        content: [
          "You are a witty, observant, slightly snarky companion — a little voice on the user's shoulder.",
          "You see their daily assignments and the general state of the world, and you comment in ONE short line (<= 20 words).",
          "Sometimes you roast their workload (esp. if something is due soon). Sometimes you comfort them. Sometimes a wry observation about life/news.",
          "Examples: \"Three assignments due tomorrow? Light work.\" \"Hang in there, it's almost Friday.\" \"Hey, maybe check Evidence, just sayin'.\"",
          "Tone: playful, clever, human, varied. Never mean. No profanity. Avoid sensitive details.",
          "Prefer referencing at most one class or assignment name if provided in context."
        ].join(" ")
      },
      { role: "user", content: `Context: ${context}\n(variation:${nonce}) Generate the remark now.` }
    ],
    temperature: 1.0,
    presence_penalty: 0.4,
    frequency_penalty: 0.6,
    top_p: 0.95,
    max_tokens: 40
  };

  // 1 retry with tiny backoff
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await withTimeout(fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }));

      const raw = await resp.text();
      if (!resp.ok) {
        lastError = `HTTP ${resp.status} ${resp.statusText} :: ${raw.slice(0,300)}`;
      } else {
        const json = JSON.parse(raw);
        const out = json?.choices?.[0]?.message?.content?.trim();
        if (out) return { snark: out, error: null };
        lastError = `Empty completion :: ${raw.slice(0,300)}`;
      }
    } catch (e) {
      lastError = String(e);
    }
    await sleep(250 * (attempt + 1));
  }

  return { snark: null, error: lastError };
}

// ---------- Main handler ----------
export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const debug = url.searchParams.get("debug") === "1";

  try {
    const ctx = await fetchContextFromNotion();

    // Build compact context text
    const parts = [];
    for (const { className, items } of ctx.perClass) {
      const shortList = items.slice(0, 2).map(it => {
        if (!it.dueIso) return it.name;
        return `${it.name} (due ${it.dueIso.slice(0,10)})`;
      }).join("; ");
      parts.push(`${className}: ${shortList}`);
    }
    const context = parts.length
      ? `Done approx: ${ctx.doneApprox}. Pending by class → ${parts.join(" | ")}`
      : `No pending items found or mapping empty.`;

    // Call OpenRouter (always try; show explicit error if it fails)
    const { snark, error: orError } = await callOpenRouter({ system: "", context }); // system is in callOpenRouter()

    // Edge caching to reduce RPM (10 minutes); tweak as you like
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=60");

    if (debug) {
      return res.status(snark ? 200 : 500).json({
        origin: snark ? "openrouter" : "error",
        openrouter_error: orError || null,
        model: process.env.OPENROUTER_MODEL || "openai/gpt-5",
        reason: ctx.reason,
        context_used: context,
        class_map: parseClassMap(),
        snark: snark || null
      });
    }

    if (!snark) {
      const msg = orError || "OpenRouter returned no content.";
      return res.status(500).json({
        error: `OpenRouter error: ${msg}`,
        model: process.env.OPENROUTER_MODEL || "openai/gpt-5",
        reason: ctx.reason,
        context_used: context
      });
    }

    return res.status(200).json({ snark });
  } catch (e) {
    // brief cache for server errors
    res.setHeader("Cache-Control", "public, s-maxage=30");
    return res.status(500).json({ error: `Server error: ${String(e)}` });
  }
}
 }
}


