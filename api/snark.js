// api/snark.js
// Notion-aware snark for per-class assignments.
// - Map checkboxes to class text columns via NOTION_CLASS_MAP like:
//   S-A:NYP_1,C-A:Conflict_of_Laws,E-A:Evidence,SC-A:State_and_Local_Tax,N-A:Supreme_Court_Watch
//   (underscores become spaces)
// - Title fallback via NOTION_TITLE_PROP (e.g., "Classes:")
// - Due date via NOTION_DUE_PROP (e.g., "Date")

const NOTION_VERSION = "2022-06-28";
const TIMEOUT_MS = 6000;

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
      // underscores -> spaces so env values are easy to type
      return {
        checkbox: checkbox.replace(/_/g, " "),
        textProp: textProp.replace(/_/g, " "),
      };
    })
    .filter(Boolean);
}

async function notionQuery(dbId, headers, body) {
  const url = `https://api.notion.com/v1/databases/${dbId}/query`;
  return withTimeout(fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })).then(r => r.json());
}

async function fetchContextFromNotion() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ID;
  if (!token || !dbId) return { perClass: [], doneApprox: 0 };

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

  // Per-class pending: checkbox false (don’t require class rich_text non-empty; we’ll fallback to Title)
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
        // Prefer the class rich_text column
        const rt = page.properties?.[textProp]?.rich_text || [];
        let name = rt.map(t => t.plain_text).join("").trim();

        // Fallback to the Title property if class text is empty
        if (!name) {
          const titleArr = page.properties?.[TITLE]?.title || [];
          name = titleArr.map(t => t.plain_text).join("").trim();
        }
        if (!name) name = "Untitled";

        // Optional due date
        let dueIso = null;
        const due = page.properties?.[DUE];
        if (due?.type === "date" && due.date?.start) dueIso = due.date.start;

        return { name, dueIso };
      });

      if (items.length) perClass.push({ className: textProp, items });
    } catch { /* ignore */ }
  }

  return { perClass, doneApprox };
}

export default async function handler(req, res) {
  try {
    const { perClass, doneApprox } = await fetchContextFromNotion();

    // Build compact context for the model
    const parts = [];
    for (const { className, items } of perClass) {
      const shortList = items.slice(0, 2).map(it => {
        if (!it.dueIso) return it.name;
        // shorten ISO date a bit (YYYY-MM-DD)
        const d = it.dueIso.slice(0, 10);
        return `${it.name} (due ${d})`;
      }).join("; ");
      parts.push(`${className}: ${shortList}`);
    }

    const context = parts.length
      ? `Done approx: ${doneApprox}. Pending by class → ${parts.join(" | ")}`
      : `No pending items found or mapping empty.`;

    const system = [
      "Return ONE short, clever, slightly snarky remark (<= 20 words).",
      "Prefer productivity roasts when pending tasks exist; otherwise a witty world observation.",
      "Be witty, not mean. No profanity. No personal data.",
      "If context lists classes/assignments, you may reference one class or one short assignment name."
    ].join(" ");

    const user = `Context: ${context} Generate the remark now.`;

    // OpenAI call
    const completion = await withTimeout(fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.9,
        max_tokens: 40,
      }),
    })).then(r => r.json()).catch(() => null);

    const snark =
      completion?.choices?.[0]?.message?.content?.trim()
      || (perClass.length ? "Assignments multiplying; checkboxes napping. Classic." : "Universe vast; your to-do list vaster.");

    // Always fresh for the Notion widget
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.status(200).json({ snark });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ snark: "APIs moody. Consider this a mercy recess." });
  }
}
