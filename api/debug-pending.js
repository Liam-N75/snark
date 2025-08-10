// api/debug-pending.js
// api/debug-pending.js
const NOTION_VERSION = "2022-06-28";

function parseMap() {
  const raw = process.env.NOTION_CLASS_MAP || "";
  return raw.split(",").map(x => x.trim()).filter(Boolean).map(pair => {
    const [cb, txt] = pair.split(":").map(s => (s || "").trim());
    return { checkbox: cb.replace(/_/g, " "), textProp: txt.replace(/_/g, " ") };
  });
}

async function q(endpoint, headers, body) {
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  return res.json();
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
    const endpoint = `https://api.notion.com/v1/databases/${process.env.NOTION_DB_ID}/query`;

    const results = [];
    for (const { checkbox, textProp } of map) {
      // Any text present (regardless of checkbox)
      const anyText = await q(endpoint, headers, {
        filter: { property: textProp, rich_text: { is_not_empty: true } },
        page_size: 50
      });

      // Pending (checkbox false AND text present)
      const pending = await q(endpoint, headers, {
        filter: { and: [
          { property: textProp, rich_text: { is_not_empty: true } },
          { property: checkbox, checkbox: { equals: false } }
        ]},
        sorts: DUE ? [{ property: DUE, direction: "ascending" }] : undefined,
        page_size: 10
      });

      // Done (checkbox true AND text present)
      const done = await q(endpoint, headers, {
        filter: { and: [
          { property: textProp, rich_text: { is_not_empty: true } },
          { property: checkbox, checkbox: { equals: true } }
        ]},
        page_size: 10
      });

      const sample = (pending.results || []).map(p => {
        const txt = (p.properties?.[textProp]?.rich_text || []).map(t => t.plain_text).join("").trim();
        const cbv = p.properties?.[checkbox]?.checkbox === true;
        const due = p.properties?.[DUE];
        const dueIso = (due?.type === "date" && due.date?.start) ? due.date.start : null;
        return { name: txt || "(empty)", checkbox: cbv, due: dueIso };
      });

      results.push({
        textProp, checkbox,
        counts: {
          anyText: (anyText.results || []).length,
          pending: (pending.results || []).length,
          done: (done.results || []).length,
        },
        pending_samples: sample
      });
    }

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
