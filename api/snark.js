// api/snark.js

const NOTION_VERSION = "2022-06-28";
const TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}

async function fetchNotionSummary() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ID;
  if (!token || !dbId) return null;

  const DONE  = process.env.NOTION_DONE_PROP  || "Done";
  const TITLE = process.env.NOTION_TITLE_PROP || "Name";
  const DUE   = process.env.NOTION_DUE_PROP   || null;

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json"
  };

  try {
    const doneResp = await withTimeout(
      fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: "POST", headers,
        body: JSON.stringify({ filter: { property: DONE, checkbox: { equals: true } }, page_size: 100 })
      }), TIMEOUT_MS
    ).then(r => r.json());

    const todoResp = await withTimeout(
      fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: "POST", headers,
        body: JSON.stringify({
          filter: { property: DONE, checkbox: { equals: false } },
          page_size: 3,
          sorts: DUE ? [{ property: DUE, direction: "ascending" }] : undefined
        })
      }), TIMEOUT_MS
    ).then(r => r.json());

    if (doneResp?.object === "error" || todoResp?.object === "error") return null;

    const doneCount = (doneResp?.results || []).length;
    const sampleTodos = (todoResp?.results || []).map(p =>
      (p.properties?.[TITLE]?.title || [])[0]?.plain_text || "Untitled"
    ).slice(0, 3);

    return { doneCount, sampleTodos };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const notion = await fetchNotionSummary();

    const baseInstructions = [
      "Return ONE short, clever, slightly snarky remark (<= 20 words).",
      "Be witty, not mean. No profanity. No personal data.",
      "Prefer productivity jabs if Notion context is present; else world observation."
    ].join(" ");

    const context = notion
      ? `Done: ~${notion.doneCount}. Pending sample: ${notion.sampleTodos.join(", ")}.`
      : "No Notion context.";

    const body = {
      model: "gpt-5",
      messages: [
        { role: "system", content: baseInstructions },
        { role: "user", content: `Notion status: ${context} Give the remark now.` }
      ],
      temperature: 0.9,
      max_tokens: 40
    };

    let completion;
    try {
      completion = await withTimeout(
        fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        }), TIMEOUT_MS
      ).then(r => r.json());
    } catch {
      completion = null;
    }

    const snark =
      completion?.choices?.[0]?.message?.content?.trim()
      || (notion ? "Progress noted. Procrastination undefeated." : "Universe vast; your to-do list vaster.");

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.status(200).json({ snark });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ snark: "Systems busy. Treat this as your grace period." });
  }
}
