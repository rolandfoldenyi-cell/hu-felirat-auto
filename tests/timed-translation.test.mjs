import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranslationCache, translateTimedCues } from '../public/timed-translation.js';
const cue = (original, start, id = start) => ({ id, start, end: start + 2.75, original, translated: null });
const result = texts => ({ translations: texts.map(text => 'Magyar: ' + text), engine: 'google_free', failed: 0, failedIndices: [] });
const memoryStorage = () => { const values = new Map(); return {
  getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), values
}; };

test('repeated English lines translate once while all cue IDs and times stay exact', async () => {
  const input = [cue('Same English sentence.', 0, 'a'), cue('Another sentence.', 4.125, 'b'), cue('Same English sentence.', 10.5, 'c')];
  const before = structuredClone(input); const calls = []; const updates = [];
  const data = await translateTimedCues(input, { sourceLanguage: 'en',
    translate: async texts => { calls.push(texts); return result(texts); }, onUpdate: progress => updates.push(...progress.updates) });
  assert.deepEqual(input, before, 'The source cue list must remain unchanged');
  assert.deepEqual(calls, [['Same English sentence.', 'Another sentence.']]);
  assert.deepEqual(data.cues.map(({ id, start, end }) => ({ id, start, end })), input.map(({ id, start, end }) => ({ id, start, end })));
  assert.equal(data.cues[0].translated, data.cues[2].translated);
  assert.deepEqual(updates.map(update => update.index).sort(), [0, 1, 2]);
});

test('successful translations persist, respect language and expire after thirty days', async () => {
  const storage = memoryStorage(); let time = 1000;
  const options = { storage, now: () => time };
  const cache = createTranslationCache(options);
  const input = [cue('This is English.', 1)];
  await translateTimedCues(input, { sourceLanguage: 'en', cache, translate: async texts => result(texts) });
  const restored = createTranslationCache(options);
  const data = await translateTimedCues(input, { sourceLanguage: 'en', cache: restored,
    translate: async () => { throw new Error('A cache hit must not use the network'); } });
  assert.equal(data.cached, 1); assert.equal(data.failed, 0);
  assert.equal(restored.get(input[0].original, 'de'), null);
  time += 31 * 86400000;
  assert.equal(restored.get(input[0].original, 'en'), null);
});

test('a failed translation remains null and is retried without retranslating good cues', async () => {
  const cache = createTranslationCache({ storage: memoryStorage() });
  const input = [cue('Good line.', 1), cue('Failed line.', 5), cue('Failed line.', 9)];
  const first = await translateTimedCues(input, { sourceLanguage: 'en', cache,
    translate: async () => ({ translations: ['Jó sor.', 'Failed line.'], failed: 1, failedIndices: [1] }) });
  assert.deepEqual(first.failedIndices, [1, 2]);
  assert.equal(first.cues[1].translated, null); assert.equal(first.cues[2].translated, null);
  assert.equal(cache.get('Failed line.', 'en'), null);
  const calls = [];
  const retry = await translateTimedCues(input, { sourceLanguage: 'en', cache,
    translate: async texts => { calls.push(texts); return result(texts); } });
  assert.deepEqual(calls, [['Failed line.']]); assert.equal(retry.cached, 1); assert.equal(retry.failed, 0);
});

test('missing or unaligned provider output cannot shift text onto another cue', async () => {
  const input = [cue('First.', 0), cue('Second.', 4), cue('Third.', 8)]; let calls = 0;
  const data = await translateTimedCues(input, { maxBatchSize: 2,
    translate: async texts => ++calls === 1 ? { translations: ['A merged response'] } : result(texts) });
  assert.equal(data.cues[0].translated, null); assert.equal(data.cues[1].translated, null);
  assert.equal(data.cues[2].translated, 'Magyar: Third.'); assert.equal(data.failed, 2);
  assert.match(data.lastError, /hiányos/);
});

test('aborting ignores an uncooperative provider response and does not cache stale text', async () => {
  const cache = createTranslationCache({ storage: memoryStorage() });
  const controller = new AbortController(); let finish; let updates = 0;
  const pending = translateTimedCues([cue('Late old video.', 2)], { signal: controller.signal, sourceLanguage: 'en', cache,
    translate: () => new Promise(resolve => { finish = resolve; }), onUpdate: () => updates++ });
  controller.abort(); finish(result(['Late old video.']));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(updates, 0); assert.equal(cache.get('Late old video.', 'en'), null);
});

test('request batches limit encoded length without discarding or reordering cues', async () => {
  const input = [cue('é'.repeat(20), 0), cue('ö'.repeat(20), 4), cue('ű'.repeat(20), 8)];
  const calls = [];
  const data = await translateTimedCues(input, { maxEncodedChars: 200,
    translate: async texts => { calls.push(texts); return result(texts); } });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.flat(), input.map(item => item.original)); assert.equal(data.failed, 0);
});

test('restricted, corrupt or full storage never blocks translation; cache size stays bounded', async () => {
  const cache = createTranslationCache({ maxEntries: 2, storage: memoryStorage() });
  cache.set('a', 'en', 'A'); cache.set('b', 'en', 'B'); cache.get('a', 'en'); cache.set('c', 'en', 'C');
  assert.equal(cache.get('b', 'en'), null); assert.equal(cache.get('a', 'en'), 'A');
  for (const storage of [{ getItem: () => '{broken', setItem() {} },
    { getItem() { throw new Error('Restricted'); }, setItem() { throw new Error('Full'); } }]) {
    const data = await translateTimedCues([cue('Valid source.', 0)], {
      cache: createTranslationCache({ storage }), translate: async texts => result(texts) });
    assert.equal(data.failed, 0);
  }
});

test('invalid cue times are rejected before any external translation', async () => {
  await assert.rejects(translateTimedCues([{ ...cue('Text.', 0), end: -1 }], {
    translate: async () => { throw new Error('Must not be called'); } }), /időzítése/);
});
