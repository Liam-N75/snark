// api/snark.js
// api/snark.js
// Reads per-class assignment names from rich_text columns, paired with their checkbox columns,
// and roasts pending items (unchecked) with optional Date.

const NOTION_VERSION = "2022-06-28";
const TIMEOUT_MS = 6000;

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

// Parse NOTION_CLASS_MAP like: "S-A:NYP 1,C-A:Supreme Court Watch,E-A:Evidence"
function parseClassMap() {
  const raw = process.env.NOTION_CLASS_MAP || "";
  return raw
    .split(",")
    .map(pair => pair.trim())
    .filter(Boolean)
    .map(pair => {
      const [checkbox, textProp] = pair.split(":").map(s => (s || "").trim());
      if (!checkbox || !textProp) return null;
      // Replace underscores with spaces so env vars can avoid literal spaces
      return { checkbox: checkbox.replace(/_/g, " "), textProp: textProp.replace(/_/g, " ") };
    })
    .filter(Boolean);
}

async function queryNotion(endpoint, options) {
  return withTimeout(fetch(endpoint, options)).then(r => r.json());
}

async function fetchPerClassPending() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ID;
  if (!token || !dbId) return { perClass: [], doneApprox: 0 };

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  const DUE = process.env.NOTION_DUE_PROP || "Date";
  const classMap = parseClassMap();

  // 1) Approx done count = any row where ANY mapped checkbox is true (sample up to 100)
  let doneApprox = 0;
  if (classMap.length) {
    const orFilter =
      classMap.length === 1
        ? { property: classMap[0].checkbox, checkbox: { equals: true } }
        : { or: classMap.map(({ checkbox }) => ({ property: checkbox, checkbox: { equals: true } })) };

    const doneResp = await queryNotion(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filter: orFilter, page_size: 100 }),
    }).catch(() => null);

    if (doneResp && doneResp.object !== "error") {
      doneApprox = (doneResp.results || []).length;
    }
  }

  // 2) For each class, pull a few pending items (checkbox false AND class text not empty)
  const perClass = [];
  for (const { checkbox, textProp } of classMap) {
    const filter = {
      and: [
        { property: checkbox, checkbox: { equals: false } },
        { property: textProp, rich_text: { is_not_empty: true } },
      ],
    };

    const sorts = DUE ? [{ property: DUE, direction: "ascending" }] : undefined;

    const resp = await queryNotion(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filter, page_size: 3, sorts }),
    }).catch(() => null);

    if (!resp || resp.object === "error") continue;

    const items = (resp.results || []).map(page => {
      const textArr = page.properties?.[textProp]?.rich_text || [];
      const name = textArr.map(t => t.plain_text).join("").trim() || "Untitled";
      let dueIso = null;
      const due = page.properties?.[DUE];
      if (due?.type === "date" && due.date?.start) {
        dueIso = due.date.start; // ISO date string
      }
      return { name, dueIso };
    });

    if (items.length) perClass.push({ className: textProp, items });
  }

  return { perClass, doneApprox };
}

export default async function handler(req, res) {
  try {
    const { perClass, doneApprox } = await fetchPerClassPending();

    // Build a compact context string for the model
    const parts = [];
    if (perClass.length) {
      for (const { className, items } of perClass) {
        const shortList = items
          .slice(0, 2)
          .map(it => it.dueIso ? `${it.name} (due ${it.dueIso})` : it.name)
          .join("; ");
        parts.push(`${className}: ${shortList}`);
      }
    }
    const context = parts.length
      ? `Done approx: ${doneApprox}. Pending by class → ${parts.join(" | ")}`
      : `No Notion context or no pending items found.`;

    const system = [
      "Return ONE short, clever, slightly snarky remark (<= 20 words).",
      "Prefer productivity roasts when pending tasks exist; otherwise a witty world observation.",
      "Be witty, not mean. No profanity. No personal data.",
      "If context lists classes/assignments, you may reference one class or one short assignment name.",
    ].join(" ");

    const user = `Context: ${context} Generate the remark now.`;

    // Call OpenAI
    const body = {
      model: "gpt-5",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.9,
      max_tokens: 40,
    };

    const completion = await withTimeout(
      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
    ).then(r => r.json()).catch(() => null);

    const snark =
      completion?.choices?.[0]?.message?.content?.trim()
      || (perClass.length ? "Assignments multiplying; checkboxes napping. Classic." : "Universe vast; your to-do list vaster.");

    // Always fresh for the widget
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.status(200).json({ snark });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ snark: "APIs moody. Consider this a mercy recess." });
  }
}
