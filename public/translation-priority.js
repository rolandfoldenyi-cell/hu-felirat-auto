// Pure routing: Chrome/Google first; DeepL only for lines still missing.
const MULTIWORD = /\p{L}{2,}[^\p{L}]+\p{L}{2,}[^\p{L}]+\p{L}{2,}/u;

function checkAbort(signal) {
  signal?.throwIfAborted();
}

export async function createChromeSession(sourceLanguage, {
  api = globalThis.Translator, signal, onProgress = () => {}
} = {}) {
  checkAbort(signal);
  const source = String(sourceLanguage || "").toLowerCase().split("-")[0];
  if (!api || !source || source === "auto" || source === "hu") return null;
  const options = { sourceLanguage: source, targetLanguage: "hu" };
  if (await api.availability(options) === "unavailable") return null;
  checkAbort(signal);
  const session = await api.create({
    ...options,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => onProgress(event.loaded));
    }
  });
  if (signal?.aborted) {
    session.destroy();
    checkAbort(signal);
  }
  return session;
}

export async function translateByPriority(texts, {
  chromeTranslate, googleTranslate, deepLTranslate, signal
}) {
  const output = texts.slice();
  let pending = texts.map((_, i) => i);
  const used = new Set();
  let lastError;
  for (const [engine, translate] of [
    ["chrome", chromeTranslate], ["google_free", googleTranslate], ["deepl", deepLTranslate]
  ]) {
    checkAbort(signal);
    if (!translate || !pending.length) continue;
    const indices = pending.slice();
    try {
      const result = await translate(indices.map((i) => texts[i]), signal);
      checkAbort(signal);
      const lines = result?.translations;
      if (!Array.isArray(lines) || lines.length !== indices.length ||
          lines.some((text) => typeof text !== "string" || !text.trim())) {
        throw new Error("A fordító hiányos választ adott.");
      }
      pending = [];
      for (let j = 0; j < indices.length; j++) {
        const index = indices[j];
        if (MULTIWORD.test(texts[index]) &&
            lines[j].trim().toLowerCase() === texts[index].trim().toLowerCase()) {
          pending.push(index);
        } else {
          output[index] = lines[j].trim();
          used.add(engine);
        }
      }
    } catch (error) {
      checkAbort(signal);
      if (error.name === "AbortError") throw error;
      lastError = error;
    }
  }
  checkAbort(signal);
  if (pending.length === texts.length && pending.length) {
    throw lastError || new Error("Nem sikerült lefordítani a feliratot.");
  }
  return { engine: [...used].at(-1) || "google_free", engines: [...used],
    translations: output, failed: pending.length };
}
