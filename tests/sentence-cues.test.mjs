import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSentenceCues } from '../public/sentence-cues.js';
import { createTranslationCache, translateTimedCues } from '../public/timed-translation.js';
const cue = (text, start, end = start + 2) => ({ text, start, end });

test('a split sentence reaches the translator with its meaning and original outer times', async () => {
  const input = [cue('He sat on the bank', 1.125, 3.25), cue('of the river to rest.', 3.3, 5.875), cue('It was quiet.', 6)];
  const before = structuredClone(input);
  const units = prepareSentenceCues(input);
  const calls = [];
  const result = await translateTimedCues(units.map(c => ({ ...c, original: c.text })), {
    translate: async texts => { calls.push(texts); return { translations: ['Leült a folyópartra pihenni.', 'Csend volt.'] }; }
  });
  assert.deepEqual(input, before);
  assert.deepEqual(calls, [['He sat on the bank of the river to rest.', 'It was quiet.']]);
  assert.deepEqual(units.map(c => [c.start, c.end, c.sourceIndices]), [[1.125, 5.875, [0,1]], [6,8,[2]]]);
  assert.equal(result.cues[0].translated, 'Leült a folyópartra pihenni.');
  assert.equal(result.cues[0].start, input[0].start);
  assert.equal(result.cues[0].end, input[1].end);
});

test('sentence punctuation, silence, speaker changes and music are meaningful boundaries', () => {
  const input = [cue('Yes.',0),cue('We should',2),cue('leave now.',4.1),
    cue('Wait',10),cue('- I disagree.',12),cue('[Music]',14),cue('We should',16),cue('go home.',20)];
  assert.deepEqual(prepareSentenceCues(input).map(c=>c.text),
    ['Yes.','We should leave now.','Wait','- I disagree.','[Music]','We should','go home.']);
});

test('simultaneous speech and long blocks are kept separate; no source text disappears', () => {
  const input = [cue('First speaker',0,4),cue('Another speaker.',2,5),
    cue('This unfinished sentence is already long',6,9),cue('and continues a lot longer',9,14),cue('than a readable subtitle.',14,18)];
  const units = prepareSentenceCues(input,{maxSeconds:7,maxChars:65});
  assert.deepEqual(units.flatMap(c=>c.sourceIndices),[0,1,2,3,4]);
  assert.equal(units.length,5);
  assert.deepEqual(units.map(c=>c.text),input.map(c=>c.text));
});

test('line breaks do not create false translation rows and abbreviations do not end a sentence', () => {
  const units = prepareSentenceCues([cue('Ask Dr.',0),cue('Smith\nabout the\nmission.',2)]);
  assert.equal(units.length,1);assert.equal(units[0].text,'Ask Dr. Smith about the mission.');
});

test('the setting can restore individual source intervals without guessing Hungarian word alignment', () => {
  const input = [cue('We need to keep an eye',0),cue('on the road.',2)];
  const units=prepareSentenceCues(input,{enabled:false});
  assert.deepEqual(units.map(({sourceIndices,...c})=>c),input);
});

test('old fragment translations are not reused by the new sentence cache', () => {
  const old=JSON.stringify({version:1,entries:[[JSON.stringify(['en','hu','bank']),{text:'bank',at:Date.now()}]]});
  const calls=[];
  const cache=createTranslationCache({storage:{getItem(key){calls.push(key);return key==='hufelirat_translation_cache_v1'?old:null;}}});
  assert.equal(cache.get('bank','en'),null);
  assert.ok(!calls.includes('hufelirat_translation_cache_v1'));
});

test('invalid source timing is rejected rather than silently changed', () => {
  assert.throws(()=>prepareSentenceCues([cue('Text',4,3)]),/időzítés/);
});
