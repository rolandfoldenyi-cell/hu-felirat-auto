// Serverless function: translates subtitle batches to natural Hungarian.
// Supports Free Google Translate (default, no API key), Gemini AI, and OpenAI GPT.

async function translateSingleGoogleFree(text) {
  try {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=hu&dt=t&q=" +
      encodeURIComponent(text);
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!resp.ok) return text;
    const data = await resp.json();
    const parts = Array.isArray(data?.[0]) ? data[0] : [];
    const out = parts.map((p) => (Array.isArray(p) ? p[0] || "" : "")).join("").trim();
    return out || text;
  } catch {
    return text;
  }
}

async function translateWithGoogleFree(lines) {
  const sep = "\n###SEP###\n";
  const joined = lines.join(sep);
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=hu&dt=t&q=" +
    encodeURIComponent(joined);

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  if (!resp.ok) {
    throw new Error(`Google Translate HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const segments = Array.isArray(data?.[0]) ? data[0] : [];
  const full = segments.map((s) => (Array.isArray(s) ? s[0] || "" : "")).join("");

  const split = full
    .split(/\s*###\s*SEP\s*###\s*/i)
    .map((s) => s.trim());

  if (split.length === lines.length) {
    return split.map((s, i) => s || lines[i]);
  }

  // Fallback per-line if separator drifted
  const results = [];
  for (const line of lines) {
    results.push(await translateSingleGoogleFree(line));
  }
  return results;
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
    let translated;
    if (chosenEngine === "gemini") {
      translated = await translateWithGemini(cleanTexts, effectiveKey, model);
    } else if (chosenEngine === "openai") {
      translated = await translateWithOpenAi(cleanTexts, effectiveKey, model);
    } else {
      translated = await translateWithGoogleFree(cleanTexts);
    }
    return res.status(200).json({
      engine: chosenEngine,
      translations: translated
    });
  } catch (err) {
    // Fallback to free Google Translate on AI error so user still gets subtitles
    try {
      const fallback = await translateWithGoogleFree(cleanTexts);
      return res.status(200).json({
        engine: "google_free",
        fallbackWarning: err?.message || "AI hiba, automatikus váltás Google fordítóra.",
        translations: fallback
      });
    } catch (err2) {
      return res.status(502).json({
        error: err2?.message || err?.message || "A fordítás nem sikerült."
      });
    }
  }
}
