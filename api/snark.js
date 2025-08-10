// api/snark.js
// Notion-aware snark with robust fallbacks, variety, and debug mode.
//
// ENV VARS (Vercel -> Project -> Settings -> Environment Variables):
// - OPENAI_API_KEY         (required)
// - OPENAI_MODEL           (optional, default: "gpt-4o-mini")
// - NOTION_TOKEN           (required for Notion context)
// - NOTION_DB_ID           (required for Notion context)
// - NOTION_TITLE_PROP      (optional; e.g., "Classes:" — used as fallback name)
// - NOTION_DUE_PROP        (optional; e.g., "Date")
// - NOTION_CLASS_MAP       (optional; mapping "Checkbox:Class_RichText,...", underscores become spaces)
//     Example: S-A:NYP_1,C-A:Conflict_of_Laws,E-A:Evidence,SC-A:State_and_Local_Tax,N-A:Supreme_Court_Watch
//
// Debug: append ?debug=1 to see origin, errors, and context used.

const NOTION_VERSION = "2022-06-28";
const TIMEOUT_MS = 9000;

// --- Helpers ---------------------------------------------------------------

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

// Parse NOTION_CLASS_MAP -> [{ checkbox, textProp }]
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
        // underscores -> spaces for easy typing in env vars
        checkbox: checkbox.replace(/_/g, " "),
        textProp: textProp.replace(/_/g, " "),
      };
    })
    .filter(Boolean);
}

async function notionQuery(dbId, headers, body) {
  const url = `https://api.notion.com/v1/databases/${dbId}/query`;
  const res = await withTimeout(fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
  return res.json();
}

async function fetchContextFromNotion() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ID;
  if (!token || !dbId) {
    return { perClass: [], doneApprox: 0, reason: "missing_notion_env" };
  }

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  const DUE = process.env.NOTION_DUE_PROP || "Date";
  const TITLE = process.env.NOTION_TITLE_PROP || "Name";
  const classMap = parseClassMap();

  // Approx "done" = any row where any mapped checkbox is true (sample up to 100)
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
    } catch { /* ignore */ }
  }

  // Per-class pending: checkbox false (we do NOT require the class rich_text to be non-empty;
  // we'll fall back to Title when needed)
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

      const items = (pendingResp.results || []).map(page => {
        // Prefer the class rich_text column for assignment name
        const rt = page.properties?.[textProp]?.rich_text || [];
        let name = rt.map(t => t.plain_text).join("").trim();

        // Fallback to the Title property if class text is empty
        if (!name) {
          const titleArr = page.properties?.[TITLE]?.title || [];
          name = titleArr.map(t => t.plain_text).join("").trim();
        }
        // Final fallback label if everything's blank
        if (!name) {
          name = textProp; // e.g., "Evidence"
          const dueProp = page.properties?.[DUE];
          if (dueProp?.type === "date" && dueProp.date?.start) {
            name += ` assignment (${dueProp.date.start.slice(0,10)})`;
          } else {
            name += " assignment";
          }
        }

        // Optional due date
        let dueIso = null;
        const due = page.properties?.[DUE];
        if (due?.type === "date" && due.date?.start) dueIso = due.date.start;

        return { name, dueIso };
      });

      if (items.length) perClass.push({ className: textProp, items });
    } catch { /* ignore */ }
  }

  return {
    perClass,
    doneApprox,
    reason: perClass.length ? "ok" : "notion_empty_or_mismatch",
  };
}

// --- Main handler ----------------------------------------------------------

export default async function handler(req, res) {
  // Parse ?debug=1 safely (Node runtime)
  const url = new URL(req.url, "http://localhost");
  const debug = url.searchParams.get("debug") === "1";

  try {
    const ctx = await fetchContextFromNotion();

    // Build compact context text for the model
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

    // Inject a nonce to subtly nudge variety without changing meaning
    const nonce = Math.random().toString(36).slice(2, 8);

    // OpenAI call with variety settings
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    let origin = "openai";
    let snark = null;
    let openai_error = null;

    try {
      const resp = await withTimeout(fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 1.05,
          presence_penalty: 0.4,
          frequency_penalty: 0.6,
          top_p: 0.95,
          max_tokens: 40,
          messages: [
            {
              role: "system",
              content: [
                "Return ONE short, clever, slightly snarky remark (<= 20 words).",
                "Prefer productivity roasts when pending tasks exist; otherwise a witty world observation.",
                "Be witty, not mean. No profanity. No personal data.",
                "If context lists classes/assignments, you may reference one class or one short assignment name."
              ].join(" ")
            },
            { role: "user", content: `Context: ${context}\n(variation:${nonce}) Generate the remark now.` }
          ]
        }),
      }));

      if (!resp.ok) {
        openai_error = `HTTP ${resp.status} ${resp.statusText}`;
      }

      const completion = await resp.json().catch(() => null);
      snark = completion?.choices?.[0]?.message?.content?.trim() || null;

      if (!snark && completion?.error) {
        openai_error = completion.error.message || JSON.stringify(completion.error);
      }
    } catch (e) {
      openai_error = String(e);
    }

    // Randomized fallbacks so it doesn't feel stuck during errors
    const FallbacksNoCtx = [
      "Universe vast; your to-do list vaster.",
      "New tab opened. Productivity achieved… allegedly.",
      "Today’s forecast: 90% chance of postponement."
    ];
    const FallbacksWithCtx = [
      "Assignments multiplying; checkboxes napping. Classic.",
      "Your tasks are social—they prefer groups.",
      "Progress noted. Procrastination still the fan favorite."
    ];

    if (!snark) {
      origin = ctx.perClass.length ? "fallback_with_context" : "fallback_no_context";
      const pool = ctx.perClass.length ? FallbacksWithCtx : FallbacksNoCtx;
      snark = pool[Math.floor(Math.random() * pool.length)];
    }

    // Always fresh for the Notion widget
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");

    if (debug) {
      return res.status(200).json({
        origin,
        reason: ctx.reason,
        openai_error,
        model,
        context_used: context,
        class_map: parseClassMap(),
        snark
      });
    }

    return res.status(200).json({ snark });
  } catch (e) {
    // Final safety net
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ snark: "APIs moody. Consider this a mercy recess." });
  }
}

