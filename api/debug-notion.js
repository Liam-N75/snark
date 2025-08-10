// api/debug-notion.js
const NOTION_VERSION = "2022-06-28";

export default async function handler(req, res) {
  try {
    const hasToken = !!process.env.NOTION_TOKEN;
    const hasDbId = !!process.env.NOTION_DB_ID;

    if (!hasToken || !hasDbId) {
      return res.status(200).json({
        ok: false,
        reason: "Missing env var(s)",
        hasToken,
        hasDbId,
        need: ["NOTION_TOKEN", "NOTION_DB_ID"]
      });
    }

    const headers = {
      "Authorization": `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    };

    // Fetch DB metadata so we can see property names/types
    const db = await fetch(`https://api.notion.com/v1/databases/${process.env.NOTION_DB_ID}`, { headers })
      .then(r => r.json());

    return res.status(200).json({
      ok: db?.object !== "error",
      db_id_used: process.env.NOTION_DB_ID,
      error: db?.object === "error" ? db : null,
      properties: db?.properties
        ? Object.entries(db.properties).map(([name, def]) => ({ name, type: def.type }))
        : null
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
