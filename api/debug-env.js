// api/debug-env.js
export default async function handler(req, res) {
  const mask = v => (v ? `${v.slice(0,3)}…(len:${v.length})` : null);
  res.status(200).json({
    runtime: "node",
    // Booleans so you can see which ones exist
    has: {
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      NOTION_TOKEN: !!process.env.NOTION_TOKEN,
      NOTION_DB_ID: !!process.env.NOTION_DB_ID,
      NOTION_TITLE_PROP: !!process.env.NOTION_TITLE_PROP,
      NOTION_DUE_PROP: !!process.env.NOTION_DUE_PROP,
      NOTION_CLASS_MAP: !!process.env.NOTION_CLASS_MAP,
    },
    // Masked preview (never prints the full secret)
    sample: {
      OPENAI_API_KEY: mask(process.env.OPENAI_API_KEY || ""),
    },
    vercel: {
      NODE_ENV: process.env.NODE_ENV || null,
      VERCEL_ENV: process.env.VERCEL_ENV || null,   // "production" | "preview" | "development"
      VERCEL_URL: process.env.VERCEL_URL || null,
    }
  });
}
