// api/debug-pending.js
const NOTION_VERSION = "2022-06-28";

function parseMap() {
  const raw = process.env.NOTION_CLASS_MAP || "";
  return raw.split(",").map(x => x.trim()).filter(Boolean).map(pair => {
    const [cb, txt] = pair.split(":").map(s => (s || "").trim());
    return { checkbox: cb.replace(/_/g, " "), textProp: txt.replace(/_/g, " ") };
  });
}

export default async function handler(req, res) {
  try {
    if (!process.env.NOTION_TOKEN || !process.env.NOTION_DB_ID) {
      return res.status(200).json({ ok: false, reason: "Missing NOTION_TOKEN or NOTION_DB_ID" });
    }
    const headers = {
      "Authorization": `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    };
    const DUE = process.env.NOTION_DUE_PROP || "Date";
    const map = parseMap();

    const results = [];
    for (const { checkbox, textProp } of map) {
      const filter = {
        and: [
          { property: checkbox, checkbox: { equals: false } },
          { property: textProp, rich_text: { is_not_empty: true } },
        ],
      };
      const sorts = DUE ? [{ property: DUE, direction: "ascending" }] : undefined;
      const q = await fetch(`https://api.notion.com/v1/databases/${process.env.NOTION_DB_ID}/query`, {
        method: "POST", headers, body: JSON.stringify({ filter, page_size: 5, sorts })
      }).then(r => r.json());
      const items = (q.results || []).map(p => {
        const txt = (p.properties?.[textProp]?.rich_text || []).map(t => t.plain_text).join("").trim();
        const due = p.properties?.[DUE];
        const dueIso = (due?.type === "date" && due.date?.start) ? due.date.start : null;
        return { name: txt || "(empty)", due: dueIso };
      });
      results.push({ checkbox, textProp, count: items.length, items });
    }

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
