// Caption acquisition is owned by the platform adapter. This module only translates
// an existing timed cue list, preserving every index, identifier and timestamp.
const CACHE_KEY = 'hufelirat_translation_cache_v1';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function createTranslationCache({ storage, maxEntries = 1500, maxChars = 500000, now = Date.now } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxChars) || maxChars < 1) throw new Error('Hibás fordítási gyorsítótár-méret.');
  const entries = new Map();
  let size = 0;
  let dirty = false;
  let backend;
  try { backend = storage === undefined ? globalThis.localStorage : storage; } catch {}
  const keyFor = (text, language) => JSON.stringify([String(language || 'auto').toLowerCase(), 'hu', text]);
  const remove = (key) => { const entry = entries.get(key); if (entry) size -= key.length + entry.text.length; entries.delete(key); };
  const trim = () => {
    while (entries.size > maxEntries || size > maxChars) remove(entries.keys().next().value);
  };
  try {
    const raw = backend?.getItem(CACHE_KEY);
    if (raw && raw.length <= maxChars * 3) {
      const data = JSON.parse(raw);
      if (data.version === 1 && Array.isArray(data.entries)) for (const [key, entry] of data.entries) {
        if (typeof key !== 'string' || !entry || typeof entry.text !== 'string' || !entry.text.trim() ||
            !Number.isFinite(entry.at) || entry.at > now() || now() - entry.at > MAX_AGE_MS) continue;
        remove(key); entries.set(key, entry); size += key.length + entry.text.length;
      }
      trim();
    }
  } catch { /* Storage restrictions and old/corrupt caches never prevent translation. */ }
  return {
    get(text, language) {
      const key = keyFor(text, language);
      const entry = entries.get(key);
      if (!entry) return null;
      if (now() - entry.at > MAX_AGE_MS) { remove(key); dirty = true; return null; }
      entries.delete(key); entries.set(key, entry);
      return entry.text;
    },
    set(text, language, translation) {
      if (typeof translation !== 'string' || !translation.trim()) return;
      const key = keyFor(text, language);
      if (key.length + translation.length > maxChars) return;
      remove(key);
      const entry = { text: translation.trim(), at: now() };
      entries.set(key, entry); size += key.length + entry.text.length; dirty = true; trim();
    },
    flush() {
      if (!dirty || !backend) return;
      try { backend.setItem(CACHE_KEY, JSON.stringify({ version: 1, entries: [...entries] })); dirty = false; }
      catch { /* Memory caching still works when browser storage is full or unavailable. */ }
    }
  };
}

export async function translateTimedCues(input, {
  translate, sourceLanguage = '', signal, cache, onUpdate = () => {},
  maxBatchSize = 20, maxEncodedChars = 4500
} = {}) {
  signal?.throwIfAborted();
  if (!Array.isArray(input) || typeof translate !== 'function') throw new Error('Hiányzik a felirat vagy a fordító.');
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxEncodedChars < 1) throw new Error('Hibás fordítási kötegméret.');
  const cues = input.map(cue => {
    if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start ||
        typeof cue.original !== 'string' || !cue.original.trim()) throw new Error('A felirat időzítése vagy szövege hibás.');
    return { ...cue, translated: null };
  });
  const groups = new Map();
  const failedIndices = [];
  const engines = new Set();
  let completed = 0;
  let cached = 0;
  let lastError = '';
  const notify = updates => {
    signal?.throwIfAborted();
    onUpdate({ updates, completed, total: cues.length, failed: failedIndices.length, cached, engines: [...engines], lastError });
  };
  const initial = [];
  for (let index = 0; index < cues.length; index++) {
    const cue = cues[index];
    const hit = cache?.get(cue.original, sourceLanguage);
    if (hit) {
      cue.translated = hit; completed++; cached++;
      initial.push({ index, translated: hit });
    } else {
      const group = groups.get(cue.original) || { text: cue.original, indices: [] };
      group.indices.push(index); groups.set(cue.original, group);
    }
  }
  if (initial.length) notify(initial);
  const pending = [...groups.values()];
  try {
    for (let offset = 0; offset < pending.length;) {
      signal?.throwIfAborted();
      const batch = [];
      let encodedChars = 0;
      while (offset < pending.length && batch.length < maxBatchSize) {
        const group = pending[offset];
        const length = encodeURIComponent(group.text).length + 3;
        if (batch.length && encodedChars + length > maxEncodedChars) break;
        batch.push(group); encodedChars += length; offset++;
      }
      let data;
      let failed = new Set();
      try {
        data = await translate(batch.map(group => group.text), signal);
        signal?.throwIfAborted();
        if (!Array.isArray(data?.translations) || data.translations.length !== batch.length ||
            data.translations.some(text => typeof text !== 'string' || !text.trim())) throw new Error('A fordító hiányos választ adott; a sorokat nem párosítjuk találgatással.');
        const indices = data.failedIndices || [];
        if (!Array.isArray(indices) || indices.some(index => !Number.isInteger(index) || index < 0 || index >= batch.length)) throw new Error('A fordító hibás sorazonosítót adott.');
        failed = new Set(indices);
        if (Number(data.failed) > 0 && failed.size !== Number(data.failed)) throw new Error('A fordító nem jelölte meg pontosan a sikertelen sorokat.');
        for (const engine of data.engines || [data.engine]) if (engine) engines.add(engine);
      } catch (error) {
        signal?.throwIfAborted();
        if (error.name === 'AbortError') throw error;
        lastError = error.message || 'Ismeretlen fordítási hiba.';
        failed = new Set(batch.map((_, index) => index));
      }
      const updates = [];
      for (let index = 0; index < batch.length; index++) {
        const group = batch[index];
        const translated = failed.has(index) ? null : data.translations[index].trim();
        if (translated) cache?.set(group.text, sourceLanguage, translated);
        for (const cueIndex of group.indices) {
          cues[cueIndex].translated = translated;
          if (translated === null) failedIndices.push(cueIndex);
          updates.push({ index: cueIndex, translated });
          completed++;
        }
      }
      cache?.flush();
      notify(updates);
    }
  } finally { cache?.flush(); }
  signal?.throwIfAborted();
  return { cues, total: cues.length, translated: cues.length - failedIndices.length,
    failed: failedIndices.length, failedIndices: failedIndices.sort((a, b) => a - b), cached, engines: [...engines], lastError };
}
