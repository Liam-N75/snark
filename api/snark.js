// api/snark.js
// This is a Vercel serverless function that returns a short, witty/snarky remark as JSON.
// Requires your OpenAI API key set as the environment variable OPENAI_API_KEY in Vercel.

export default async function handler(req, res) {
  try {
    const prompt = [
      "Give one short, clever, slightly snarky remark (≤ 20 words).",
      "Rotate between: world observation, gentle productivity jab, whimsical absurdity.",
      "Be witty, not mean. No profanity. No personal data.",
    ].join(" ");

    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.9,
        max_tokens: 40
      }),
    }).then(r => r.json());

    const snark =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Silence is golden. Your to-do list? Less so.";

// No caching at all — new line every request
res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
res.setHeader("Pragma", "no-cache");

  } catch (err) {
    res.status(200).json({
      snark: "Error fetching snark. Consider this a judgment-free buffer.",
      generated_at: new Date().toISOString()
    });
  }
}
