// api/snark.js
// FREE version: No OpenAI. Generates a daily quip from Notion data + simple templates.
//
// Required env vars:
// - NOTION_TOKEN
// - NOTION_DB_ID
// Recommended env vars:
// - NOTION_TITLE_PROP = "Classes:"
// - NOTION_DUE_PROP   = "Date"
// - NOTION_CLASS_MAP  = "S-A:NYP_1,C-A:Conflict_of_Laws,E-A:Evidence,SC-A:State_and_Local_Tax,N-A:Supreme_Court_Watch"
//   (underscores become spaces)
// - SNARK_SALT        = any short string to personalize daily randomness (optional)

const NOTION_VERSION = "2022-06-28";

// ------------ tiny utils (deterministic daily RNG) ------------
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function daysBetween(aISO, bISO) {
  const a = new Date(aISO); const b = new Date(bISO);
  return Math.floor((a - b) / (24 * 3600 * 1000));
}
function todayISO() {
  const d = new Date();
  // force to YYYY-MM-DD in local time
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function weekdayName(d = new Date()) {
  return d.toLocaleDateString("en-US",{ weekday: "long" });
}
function timeOfDay(d = new Date()) {
  const h = d.getHours();
  if (h < 6) return "pre-dawn";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "late-night";
}

// ------------ Notion helpers ------------
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
      return { checkbox: checkbox.replace(/_/g, " "), textProp: textProp.replace(/_/g, " ") };
    })
    .filter(Boolean);
}

async function notionQuery(dbId, headers, body) {
  const url = `https://api.notion.com/v1/databases/${dbId}/query`;
  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return resp.json();
}

async function fetchContextFromNotion() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ID;
  if (!token || !dbId) return { perClass: [], doneApprox: 0, reason: "missing_notion_env" };

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json"
  };

  const DUE   = process.env.NOTION_DUE_PROP   || "Date";
  const TITLE = process.env.NOTION_TITLE_PROP || "Name";
  const classMap = parseClassMap();

  // approx "done": any checkbox true
  let doneApprox = 0;
  if (classMap.length) {
    const orFilter = classMap.length === 1
      ? { property: classMap[0].checkbox, checkbox: { equals: true } }
      : { or: classMap.map(({ checkbox }) => ({ property: checkbox, checkbox: { equals: true } })) };
    try {
      const doneResp = await notionQuery(dbId, headers, { filter: orFilter, page_size: 100 });
      if (doneResp && doneResp.object !== "error") doneApprox = (doneResp.results || []).length;
    } catch {}
  }

  // pending per class (checkbox false)
  const perClass = [];
  for (const { checkbox, textProp } of classMap) {
    try {
      const sorts = DUE ? [{ property: DUE, direction: "ascending" }] : undefined;
      const resp = await notionQuery(dbId, headers, {
        filter: { property: checkbox, checkbox: { equals: false } },
        page_size: 10,
        sorts
      });
      if (!resp || resp.object === "error") continue;

      const items = (resp.results || []).map(page => {
        // prefer class rich_text
        const rt = page.properties?.[textProp]?.rich_text || [];
        let name = rt.map(t => t.plain_text).join("").trim();

        // fallback to Title
        if (!name) {
          const titleArr = page.properties?.[TITLE]?.title || [];
          name = titleArr.map(t => t.plain_text).join("").trim();
        }
        if (!name) name = textProp + " assignment";

        // due date
        let dueISO = null;
        const due = page.properties?.[DUE];
        if (due?.type === "date" && due.date?.start) dueISO = due.date.start;

        return { className: textProp, name, dueISO };
      });

      if (items.length) perClass.push({ className: textProp, items });
    } catch {}
  }

  return { perClass, doneApprox, reason: perClass.length ? "ok" : "notion_empty_or_mismatch" };
}

// ------------ Local templating "narrator" ------------
function generateLine(ctx) {
  const today = todayISO();
  const salt  = process.env.SNARK_SALT || "";
  const seed  = hashString(today + "|" + salt);
  const rng   = mulberry32(seed);
  const weekday = weekdayName();
  const tod     = timeOfDay();

  // Flatten pending items with basic due math
  const all = [];
  for (const group of ctx.perClass) {
    for (const it of group.items) {
      const daysTo = it.dueISO ? daysBetween(it.dueISO.slice(0,10), today) * -1 : null; // positive if future
      const isOverdue = (it.dueISO && daysBetween(today, it.dueISO.slice(0,10)) > 0);
      all.push({ ...it, daysTo, isOverdue });
    }
  }

  // Choose a focus item (nearest due or any)
  let focus = null;
  const upcoming = all.filter(x => x.daysTo !== null && x.daysTo >= 0).sort((a,b)=>a.daysTo - b.daysTo);
  if (upcoming.length) focus = upcoming[0];
  else if (all.length) focus = all[Math.floor(rng()*all.length)];

  const pendingCount = all.length;

  // Buckets of templates
  const genericDay = [
    `Happy ${weekday}. ${tod} energy: allocated.`,
    `${tod} check-in: breathe, then one small win.`,
    `Micro-wins today. Momentum is a habit.`,
    `Light touch today. One thing, then coast.`,
  ];

  const worldVibes = [
    `Weather of the soul: partly focused, chance of smug.`,
    `Breaking: attention span rallies for a quiet surge.`,
    `In world news: you, against the list. Markets optimistic.`,
    `Forecast: 70% chance of actually doing the thing.`,
  ];

  const productivity = [
    `Let’s be heroic: one ${focus?.className || "task"} now, glory later.`,
    `Tiny push on ${focus?.className || "your list"}, disproportionate peace.`,
    `Start with ${focus?.name || focus?.className || "the quick one"}. Momentum follows.`,
    `${pendingCount} pending. One will do.`,
  ];

  const dueSoon = focus && focus.daysTo !== null && focus.daysTo <= 1 && focus.daysTo >= 0 ? [
    `${focus.name} due ${focus.daysTo === 0 ? "today" : "tomorrow"}. Light work.`,
    `Clock’s tapping: ${focus.name} lands ${focus.daysTo === 0 ? "today" : "tomorrow"}.`,
    `Quick win: ${focus.name} by ${focus.daysTo === 0 ? "tonight" : "tomorrow"}.`
  ] : [];

  const overdue = focus && focus.isOverdue ? [
    `Overdue alert: ${focus.name}. No judgment—just press go.`,
    `${focus.name} wanted attention yesterday. Today will do.`,
    `Call it ‘retroactive punctuality’: ${focus.name}.`
  ] : [];

  // Pick a pool based on context priority
  let pool;
  if (overdue.length) pool = overdue;
  else if (dueSoon.length) pool = dueSoon;
  else if (pendingCount > 0) pool = productivity;
  else pool = rng() < 0.5 ? genericDay : worldVibes;

  return pick(pool, rng);
}

// ------------ Main handler ------------
export default async function handler(req, res) {
  try {
    const ctx = await fetchContextFromNotion();

    // Build a small plaintext context (useful if you ever want to show debug)
    const parts = [];
    for (const { className, items } of ctx.perClass) {
      const shortList = items.slice(0,2).map(it => it.dueISO ? `${it.name} (due ${it.dueISO.slice(0,10)})` : it.name).join("; ");
      parts.push(`${className}: ${shortList}`);
    }
    const contextText = parts.join(" | ");

    // Compose line (deterministic per day)
    const line = generateLine(ctx);

    // Cache "daily": change to 43200 (12h) or 86400 (24h) to taste
    res.setHeader("Cache-Control", "public, s-maxage=43200, stale-while-revalidate=60");

    // Debug mode if you want: append ?debug=1
    const url = new URL(req.url, "http://localhost");
    if (url.searchParams.get("debug") === "1") {
      return res.status(200).json({
        origin: "local_templates",
        reason: ctx.reason,
        today: todayISO(),
        context_used: contextText,
        snark: line
      });
    }

    return res.status(200).json({ snark: line });
  } catch (e) {
    // brief cache on errors to avoid stampedes
    res.setHeader("Cache-Control", "public, s-maxage=60");
    return res.status(500).json({ error: `Server error: ${String(e)}` });
  }
}


