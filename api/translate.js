// Serverless function: translates subtitle batches to natural Hungarian.
// Free Google Translate, with an explicitly configured DeepL account as fallback.
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

// Lines of three or more words: if one comes back unchanged, it was not translated.
const MULTIWORD = /\p{L}{2,}[^\p{L}]+\p{L}{2,}[^\p{L}]+\p{L}{2,}/u;
const untranslatedIdx = (lines, out) =>
  lines
    .map((src, i) => (MULTIWORD.test(src) && out[i].trim().toLowerCase() === src.trim().toLowerCase() ? i : -1))
    .filter((i) => i >= 0);

// Lines are joined with plain line breaks: Google keeps one output line per input line.
// (The former "###SEP###" marker was translated to "###SZEPT###", which broke every batch.)
async function googleBatch(lines) {
  const parts = (await googleFreeRaw(lines.join("\n"))).split("\n");
  return parts.length === lines.length ? parts.map((p, i) => p.trim() || lines[i]) : null;
}

// Google sometimes answers HTTP 200 with the source text echoed back, and from Vercel's
// shared IP it does so for most lines. Unchanged lines get one more try as a single
// request; if no line gets translated at all, the call fails fast instead of looping.
async function translateWithGoogleFree(lines) {
  let result = await googleBatch(lines).catch(() => null);
  if (!result) {
    result = await mapLimit(lines, 4, (line) =>
      googleFreeRaw(line)
        .then((t) => t.trim() || line)
        .catch(() => line)
    );
  }
  const retryIdx = untranslatedIdx(lines, result);
  if (retryIdx.length) {
    await sleep(400);
    const again = await googleBatch(retryIdx.map((i) => lines[i])).catch(() => null);
    if (again) {
      retryIdx.forEach((lineIdx, k) => {
        result[lineIdx] = again[k];
      });
    }
  }
  const failed = untranslatedIdx(lines, result).length;
  const eligible = lines.filter((l) => MULTIWORD.test(l)).length;
  if (eligible > 0 && failed === eligible) {
    throw new Error("A Google Fordító a szerverről egy sort sem fordított le (korlátozza a Vercel IP-címét).");
  }
  return { translations: result, failed };
}

async function translateWithDeepL(lines, key, plan) {
  if (typeof key !== "string" || !key.trim()) throw new Error("Hiányzik a DeepL API-kulcs.");
  if (!["developer", "legacy_free"].includes(plan)) throw new Error("Válassz ingyenes DeepL API-csomagot.");
  const host = plan === "legacy_free" ? "https://api-free.deepl.com" : "https://api.deepl.com";
  const resp = await fetch(host + "/v2/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "DeepL-Auth-Key " + key.trim() },
    body: JSON.stringify({ text: lines, target_lang: "HU" }),
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) {
    if (resp.status === 456) throw new Error("Elfogyott a DeepL ingyenes karakterkerete. Nem váltunk fizetős csomagra.");
    if (resp.status === 403) throw new Error("A DeepL-kulcs vagy a kiválasztott API-csomag nem megfelelő.");
    throw new Error("A DeepL nem válaszolt megfelelően (HTTP " + resp.status + ").");
  }
  const data = await resp.json();
  const translations = data?.translations?.map((item) => item?.text);
  if (!Array.isArray(translations) || translations.length !== lines.length ||
      translations.some((text) => typeof text !== "string" || !text.trim())) {
    throw new Error("A DeepL hiányos fordítást adott.");
  }
  return translations;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Csak POST kérés engedélyezett." });
  const { texts, engine = "google_free", deeplKey = "", deeplPlan = "developer" } = req.body || {};
  if (!Array.isArray(texts) || !texts.length || texts.length > 40 ||
      texts.some((text) => typeof text !== "string") || texts.join("").length > 20000) {
    return res.status(400).json({ error: "Adj meg 1–40 feliratsort, összesen legfeljebb 20 ezer karakterrel." });
  }
  // Old Gemini/OpenAI settings can never trigger billable model calls.
  if (!["google_free", "deepl"].includes(engine)) {
    return res.status(400).json({ error: "Csak az ingyenes Google és az opcionális DeepL használható." });
  }
  try {
    if (engine === "deepl") {
      const translations = await translateWithDeepL(texts, deeplKey, deeplPlan);
      return res.status(200).json({ engine: "deepl", translations, failed: 0 });
    }
    return res.status(200).json({ engine: "google_free", ...await translateWithGoogleFree(texts) });
  } catch (error) {
    return res.status(502).json({ error: error.message || "A fordítás nem sikerült." });
  }
}
