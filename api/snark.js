// api/snark.js
const NOTION_VERSION = "2022-06-28";
const TIMEOUT_MS = 9000;

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
  return withTimeout(fetch(url, { method: "POST", headers, body: JSON.stringify(body) }))
    .then(r => r.json());
}

async function fetchContextFromNotion() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ID;
  if (!token || !dbId) return { perClass: [], doneApprox: 0, reason: "missing_notion_env" };

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  const DUE = process.env.NOTION_DUE_PROP || "Date";
  const TITLE = process.env.NOTION_TITLE_PROP || "Name";
  const classMap = parseClassMap();

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
        const rt = page.properties?.[textProp]?.rich_text || [];
        let name = rt.map(t => t.plain_text).join("").trim();

        if (!name) {
          const titleArr = page.properties?.[TITLE]?.title || [];
          name = titleArr.map(t => t.plain_text).join("").trim();
        }
        if (!name) name = "Untitled";

        let dueIso = null;
        const dueProp = page.properties?.[DUE];
        if (dueProp?.type === "date" && dueProp.date?.start) dueIso = dueProp.date.start;

        return { name, dueIso };
      });

      if (items.length) perClass.push({ className: textProp, items });
    } catch { /* ignore */ }
  }

  return {
    perClass,
    doneApprox,
    reason: perClass.length ? "ok" : "notion_empty_or_mismatch"
  };
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x"); // dummy base for parsing
  const debug = url.searchParams.get("debug") === "1";

  try {
    const ctx = await fetchContextFromNotion();

    // Build compact context
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

    // Random nonce nudges variety without changing meaning
    const nonce = Math.random().toString(36).slice(2, 8);

    // Call OpenAI
    let origin = "openai";
    let snark = null;
    try {
      const completion = await withTimeout(fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5",
          temperature: 1.0,
          presence_penalty: 0.4,
          frequency_penalty: 0.6,
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
      })).then(r => r.json());

      snark = completion?.choices?.[0]?.message?.content?.trim() || null;
    } catch {
      snark = null;
    }

    if (!snark) {
      origin = ctx.perClass.length ? "fallback_with_context" : "fallback_no_context";
      snark = ctx.perClass.length
        ? "Assignments multiplying; checkboxes napping. Classic."
        : "Universe vast; your to-do list vaster.";
    }

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");

    if (debug) {
      return res.status(200).json({
        origin,
        reason: ctx.reason,
        context_used: context,
        class_map: parseClassMap(),
        snark
      });
    }

    return res.status(200).json({ snark });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ snark: "APIs moody. Consider this a mercy recess." });
  }
}
