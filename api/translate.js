// Serverless function: translates subtitle batches to natural Hungarian.
// Supports Free Google Translate (default, no API key), Gemini AI, and OpenAI GPT.
// The app translates with Google directly from the phone first; this endpoint is its fallback.

const GT_URL = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=hu&dt=t&q=";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs fn over items with at most `limit` calls in flight, keeping the order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// One Google request; retries once on rate limiting or a server error.
async function googleFreeRaw(text) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await fetch(GT_URL + encodeURIComponent(text), {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000)
    });
    if (resp.ok) {
      const data = await resp.json();
      const segments = Array.isArray(data?.[0]) ? data[0] : [];
      return segments.map((s) => (Array.isArray(s) ? s[0] || "" : "")).join("");
    }
    if (resp.status !== 429 && resp.status < 500) break;
    await sleep(700 * (attempt + 1));
  }
  throw new Error("A Google Fordító nem válaszolt (túlterhelés vagy korlátozás).");
}

// A line of three or more words that comes back unchanged was not translated.
function looksUntranslated(src, out) {
  return (
    /\p{L}{2,}[^\p{L}]+\p{L}{2,}[^\p{L}]+\p{L}{2,}/u.test(src) &&
    out.trim().toLowerCase() === src.trim().toLowerCase()
  );
}

// Lines are joined with plain line breaks: Google keeps one output line per input line.
// (The former "###SEP###" marker was translated to "###SZEPT###", which broke every batch.)
async function translateWithGoogleFree(lines) {
  let result = null;
  try {
    const parts = (await googleFreeRaw(lines.join("\n"))).split("\n");
    if (parts.length === lines.length) result = parts.map((p, i) => p.trim() || lines[i]);
  } catch {
    // falls back to line-by-line below
  }
  const single = (line) =>
    googleFreeRaw(line)
      .then((t) => t.trim() || line)
      .catch(() => line);
  if (!result) result = await mapLimit(lines, 4, single);

  const retryIdx = result.map((t, i) => (looksUntranslated(lines[i], t) ? i : -1)).filter((i) => i >= 0);
  if (retryIdx.length) {
    const again = await mapLimit(retryIdx, 4, (i) => single(lines[i]));
    retryIdx.forEach((lineIdx, k) => {
      result[lineIdx] = again[k];
    });
  }
  const failed = result.filter((t, i) => looksUntranslated(lines[i], t)).length;
  if (failed > 0 && failed === lines.length) {
    throw new Error("A Google Fordító egyetlen sort sem fordított le.");
  }
  return { translations: result, failed };
}

function mapIndexedItems(arr, fallback) {
  const map = new Map();
  if (Array.isArray(arr)) {
    for (const item of arr) {
      if (item && typeof item.i === "number" && typeof item.t === "string") {
        const clean = item.t.trim();
        if (clean) map.set(item.i, clean);
      }
    }
  }
  return fallback.map((orig, i) => map.get(i) || orig);
}

async function translateWithGemini(lines, apiKey, model) {
  const useModel = (model || "gemini-2.5-flash").trim();
  const payloadItems = lines.map((t, i) => ({ i, t }));

  const prompt = [
    "Fordítsd le az alábbi YouTube feliratokat természetes, gördülékeny, kontextushelyes magyar nyelvre.",
    "Figyelj az egymást követő sorok összefüggésére, hogy ne legyen tükörfordítás.",
    'KIZÁRÓLAG érvényes JSON tömböt adj vissza, pontosan ugyanennyi elemmel: [{"i": 0, "t": "magyar fordítás"}]',
    "Ne hagyj ki elemet, ne vonj össze elemeket, ne írj magyarázatot.",
    "",
    "Bemenet:",
    JSON.stringify(payloadItems)
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    })
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`Gemini API hiba (${resp.status}): ${errTxt.slice(0, 140)}`);
  }

  const data = await resp.json();
  let rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  rawText = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const startIdx = rawText.indexOf("[");
  const endIdx = rawText.lastIndexOf("]");
  if (startIdx === -1 || endIdx <= startIdx) {
    throw new Error("A Gemini válasza nem érvényes JSON tömb.");
  }
  const arr = JSON.parse(rawText.slice(startIdx, endIdx + 1));
  return mapIndexedItems(arr, lines);
}

async function translateWithOpenAi(lines, apiKey, model) {
  const useModel = (model || "gpt-4o-mini").trim();
  const payloadItems = lines.map((t, i) => ({ i, t }));

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: useModel,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'Profi YouTube feliratfordító vagy. Fordíts természetes, gördülékeny, kontextushelyes magyar nyelvre. KIZÁRÓLAG JSON objektumot adj vissza: {"items": [{"i": 0, "t": "magyar szöveg"}]} pontosan azonos elemszámmal.'
        },
        {
          role: "user",
          content: JSON.stringify(payloadItems)
        }
      ]
    })
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`OpenAI API hiba (${resp.status}): ${errTxt.slice(0, 140)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  return mapIndexedItems(parsed.items, lines);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Csak POST kérés engedélyezett." });
  }

  const { texts, engine = "google_free", apiKey = "", model = "" } = req.body || {};
  if (!Array.isArray(texts) || texts.length === 0) {
    return res.status(400).json({ error: "Hiányzik a lefordítandó szöveglista." });
  }

  const cleanTexts = texts.slice(0, 40).map((t) => String(t || "").trim());
  const effectiveKey =
    apiKey ||
    (engine === "gemini" ? process.env.GEMINI_API_KEY || "" : "") ||
    (engine === "openai" ? process.env.OPENAI_API_KEY || "" : "");

  const chosenEngine =
    (engine === "gemini" || engine === "openai") && !effectiveKey
      ? "google_free"
      : engine;

  try {
    if (chosenEngine === "gemini" || chosenEngine === "openai") {
      const translated =
        chosenEngine === "gemini"
          ? await translateWithGemini(cleanTexts, effectiveKey, model)
          : await translateWithOpenAi(cleanTexts, effectiveKey, model);
      return res.status(200).json({ engine: chosenEngine, translations: translated, failed: 0 });
    }
    const google = await translateWithGoogleFree(cleanTexts);
    return res.status(200).json({ engine: "google_free", ...google });
  } catch (err) {
    // An AI error falls back to free Google Translate so the user still gets subtitles.
    if (chosenEngine === "google_free") {
      return res.status(502).json({ error: err?.message || "A fordítás nem sikerült." });
    }
    try {
      const fallback = await translateWithGoogleFree(cleanTexts);
      return res.status(200).json({
        engine: "google_free",
        fallbackWarning: err?.message || "AI hiba, automatikus váltás Google fordítóra.",
        ...fallback
      });
    } catch (err2) {
      return res.status(502).json({
        error: err2?.message || err?.message || "A fordítás nem sikerült."
      });
    }
  }
}
