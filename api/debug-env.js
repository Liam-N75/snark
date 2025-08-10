// api/debug-env.js  (extend yours or create)
// Shows whether the key is present (masked)
export default async function handler(req, res) {
  const mask = v => (v ? `${v.slice(0,6)}…(len:${v.length})` : null);
  res.status(200).json({
    has: {
      OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
      OPENROUTER_MODEL: !!process.env.OPENROUTER_MODEL,
    },
    sample: {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ? mask(process.env.OPENROUTER_API_KEY) : null,
      OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || null,
    },
    vercel: {
      VERCEL_ENV: process.env.VERCEL_ENV || null,
      VERCEL_URL: process.env.VERCEL_URL || null,
    }
  });
}
