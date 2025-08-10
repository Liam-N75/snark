// api/debug-config.js
export default async function handler(req, res) {
  const rawMap = process.env.NOTION_CLASS_MAP || "";
  const parsed = rawMap
    .split(",").map(s => s.trim()).filter(Boolean)
    .map(pair => {
      const [checkbox, textProp] = pair.split(":").map(s => (s || "").trim());
      return {
        checkbox_raw: checkbox,
        text_raw: textProp,
        checkbox_resolved: (checkbox || "").replace(/_/g, " "),
        text_resolved: (textProp || "").replace(/_/g, " "),
      };
    });

  res.status(200).json({
    has_OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    has_NOTION_TOKEN: !!process.env.NOTION_TOKEN,
    has_NOTION_DB_ID: !!process.env.NOTION_DB_ID,
    NOTION_DUE_PROP: process.env.NOTION_DUE_PROP || null,
    NOTION_CLASS_MAP_raw: rawMap,
    NOTION_CLASS_MAP_parsed: parsed,
  });
}
