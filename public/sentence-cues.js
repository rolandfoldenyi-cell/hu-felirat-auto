// Join only adjacent fragments of the same utterance. Translate the complete text
// once and display it over its original outer interval; never guess word alignment.
const TERMINAL = /[.!?…]["'”’\])]*$/u;
const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|U\.S|U\.K)\.$/iu;
const ANNOTATION = /^(?:\[[^\]]+\]|\([^()]+\)|[♪♫].*)$/u;
const SPEAKER = /^(?:[-–—]\s*\p{L}|>>|[\p{L}][\p{L}\p{N}_. ]{0,24}:\s)/u;
const clean = text => text.replace(/\s+/gu, ' ').trim();

export function prepareSentenceCues(input, {
  enabled = true, maxChars = 160, maxSeconds = 8, maxCues = 6, maxGap = 0.65
} = {}) {
  if (!Array.isArray(input)) throw new Error('Hiányzik az időzített felirat.');
  const output = [];
  input.forEach((cue, index) => {
    if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start ||
        typeof cue.text !== 'string' || !cue.text.trim()) throw new Error('Hibás feliratszöveg vagy időzítés.');
    const text = clean(cue.text);
    const previous = output.at(-1);
    const gap = previous ? cue.start - previous.end : Infinity;
    const complete = previous && TERMINAL.test(previous.text) && !ABBREVIATION.test(previous.text);
    const canJoin = enabled && previous && !complete && gap >= -0.05 && gap <= maxGap
      && !ANNOTATION.test(previous.text) && !ANNOTATION.test(text) && !SPEAKER.test(text)
      && previous.sourceIndices.length < maxCues && cue.end - previous.start <= maxSeconds
      && previous.text.length + text.length + 1 <= maxChars;
    if (canJoin) {
      previous.text += ' ' + text;
      previous.end = Math.max(previous.end, cue.end);
      previous.sourceIndices.push(index);
    } else output.push({ ...cue, text, sourceIndices: [index] });
  });
  return output;
}
