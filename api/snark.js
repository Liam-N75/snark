// api/snark.js
// GPT-5 companion: Notion-aware quips with robust retries + debug.
//
// ENV VARS required:
// - OPENAI_API_KEY
// - NOTION_TOKEN
// - NOTION_DB_ID
// Recommended:
// - NOTION_TITLE_PROP = "Classes:"
// - NOTION_DUE_PROP   = "Date"
// - NOTION_CLASS_MAP  = "S-A:NYP_1,C-A:Conflict_of_Laws,E-A:Evidence,SC-A:State_and_Local_Tax,N-A:Supreme_Court_Watch"
//   (underscores become spaces)

const NOTION_VERSION = "2022-06-28";
const OPENAI_MODEL = "gpt-5"; // locked to GPT-5
const TIMEOUT_MS = 9000;

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

function parseClassMap() {
  const raw = process.env.NOTION_CLASS_MAP || "";
  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [checkbox, textProp] = pair.split(":").map((s) => (s || "").trim());
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
  const res = await withTimeout(
    fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
  );
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

  // Approx done = any mapped checkbox true (sample up to 100)
  let doneApprox = 0;
  if (classMap.length) {
    const orFilter =
      classMap.length === 1
        ? { property: classMap[0].checkbox, checkbox: { equals: true } }
        : {
            or: classMap.map(({ checkbox }) => ({
              property: checkbox,
              checkbox: { equals: true },
            })),
          };
    try {
      const doneResp = await notionQuery(dbId, headers, {
        filter: orFilter,
        page_size: 100,
      });
      if (doneResp && doneResp.object !== "error") {
        doneApprox = (doneResp.results || []).length;
      }
    } catch {}
  }

  // Pending per class = checkbox false (don’t require rich_text; we’ll fall back to Title)
  const perClass = [];
  for (const { checkbox, textProp } of classMap) {
    try {
      const sorts = DUE ? [{ property: DUE, direction: "ascending" }] : undefined;
      const pendingResp = await notionQuery(dbId, headers, {
        filter: { property: checkbox, checkbox: { equals: false } },
        page_size: 5,
        sorts,
      });
      if (!pendingResp || pendingResp.object === "error") continue;

      const items = (pendingResp.results || []).map((page) => {
        const rt = page.properties?.[textProp]?.rich_text || [];
        let name = rt.map((t) => t.plain_text).join("").trim();

        if (!name) {
          const titleArr = page.properties?.[TITLE]?.title || [];
          name = titleArr.map((t) => t.plain_text).join("").trim();
        }
        if (!name) {
          name = textProp; // last-resort label
          const dueProp = page.properties?.[DUE];
          if (dueProp?.type === "date" && dueProp.date?.start) {
            name += ` assignment (${dueProp.date.start.slice(0, 10)})`;
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

  return {
    perClass,
    doneApprox,
    reason: perClass.length ? "ok" : "notion_empty_or_mismatch",
  };
}

async function callOpenAI({ system, context }) {
  const nonce = Math.random().toString(36).slice(2, 8);
  const body = {
    model: OPENAI_MODEL,
    temperature: 1.05,
    presence_penalty: 0.4,
    frequency_penalty: 0.6,
    top_p: 0.95,
    max_tokens: 40,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Context: ${context}\n(variation:${nonce}) Generate the remark now.` },
    ],
  };

  // Retry up to 2 times (total 3 attempts)
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await withTimeout(
        fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        })
      );
      const text = await resp.text(); // capture raw for better error surfacing
      if (!resp.ok) {
        lastError = `HTTP ${resp.status} ${resp.statusText} :: ${text.slice(0, 200)}`;
      } else {
        const json = JSON.parse(text);
        const out = json?.choices?.[0]?.message?.content?.trim();
        if (out) return { snark: out, error: null, attempts: attempt + 1 };
        lastError = `Empty completion :: ${text.slice(0, 200)}`;
      }
    } catch (e) {
      lastError = String(e);
    }
    await sleep(250 * (attempt + 1));
  }
  return { snark: null, error: lastError, attempts: 3 };
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const debug = url.searchParams.get("debug") === "1";

  try {
    const ctx = await fetchContextFromNotion();

    // Build compact context string
    const parts = [];
    for (const { className, items } of ctx.perClass) {
      const shortlist = items
        .slice(0, 2)
        .map((it) => (it.dueIso ? `${it.name} (due ${it.dueIso.slice(0, 10)})` : it.name))
        .join("; ");
      parts.push(`${className}: ${shortlist}`);
    }
    const context =
      parts.length
        ? `Done approx: ${ctx.doneApprox}. Pending by class → ${parts.join(" | ")}`
        : `No pending items found or mapping empty.`;

    // Friendly, present “voice on your shoulder”
    const system = [
      "You are a witty, observant, slightly snarky companion — a little voice on the user's shoulder.",
      "You see their daily assignments and the general state of the world, and you comment in ONE short line (<= 20 words).",
      "Sometimes you roast their workload (esp. if something is due soon). Sometimes you comfort them. Sometimes a wry observation about life/news.",
      "Examples: \"Three assignments due tomorrow? Light work.\" \"Hang in there, it's almost Friday.\" \"Hey, maybe check Evidence, just sayin'.\"",
      "Tone: playful, clever, human, varied. Never mean. No profanity. Avoid revealing sensitive details.",
      "Prefer referencing at most one class or assignment name if provided in context.",
    ].join(" ");

    // Always attempt GPT-5 (even if context is bare)
    const { snark, error: openai_error, attempts } = await callOpenAI({ system, context });

    // Rotating fallbacks if OpenAI fails
    const FallbacksNoCtx = [
      "Universe vast; your to-do list vaster.",
      "New tab opened. Productivity achieved… allegedly.",
      "Today’s forecast: 90% chance of postponement.",
      "Momentum acquired. Direction… negotiable.",
    ];
    const FallbacksWithCtx = [
      "Assignments multiplying; checkboxes napping. Classic.",
      "Your tasks are social—they prefer groups.",
      "Progress noted. Procrastination still the fan favorite.",
      "Deadlines circling like very punctual vultures.",
    ];

    let origin = "openai";
    let line = snark;
    if (!line) {
      origin = ctx.perClass.length ? "fallback_with_context" : "fallback_no_context";
      const pool = ctx.perClass.length ? FallbacksWithCtx : FallbacksNoCtx;
      line = pool[Math.floor(Math.random() * pool.length)];
    }

    // Always fresh for the Notion widget
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");

    if (debug) {
      return res.status(200).json({
        origin,
        reason: ctx.reason,
        openai_attempts: attempts,
        openai_error,
        model: OPENAI_MODEL,
        context_used: context,
        class_map: parseClassMap(),
        snark: line,
      });
    }

    return res.status(200).json({ snark: line });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ snark: "APIs moody. Consider this a mercy recess." });
  }
}


