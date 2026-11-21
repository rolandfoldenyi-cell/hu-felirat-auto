import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeCaptionClient, nativeCaptionClient } from '../public/native-captions.js';

const videoId = 'dQw4w9WgXcQ';
const vtt = 'WEBVTT\n\n00:00:01.250 --> 00:00:03.500\nHello, how are you?\n\n00:00:05.000 --> 00:00:07.000\nNice to see you.';
const payload = { videoId, title: 'Video', selectedTrack: { langCode: 'en' }, tracks: [], vtt, source: 'android' };
function bridge() {
  const sent = [];
  const port = { postMessage: text => sent.push(JSON.parse(text)) };
  const reply = message => port.onmessage({ data: JSON.stringify(message) });
  return { port, sent, reply };
}

test('ordinary PWA has no native caption port', () => assert.equal(nativeCaptionClient, null));

test('device VTT retains original cue timestamps and text', async () => {
  const b = bridge(); const client = createNativeCaptionClient(b.port);
  const result = client.extract(videoId);
  assert.deepEqual(b.sent[0], { type: 'extract', id: '1', videoId, lang: 'en' });
  b.reply({ id: '1', ok: true, data: payload });
  const data = await result;
  assert.deepEqual(data.cues, [{ start: 1.25, end: 3.5, text: 'Hello, how are you?' },
    { start: 5, end: 7, text: 'Nice to see you.' }]);
  assert.equal(data.alreadyHungarian, false);
});

test('abort cancels native work; old replies cannot resolve the next video', async () => {
  const b = bridge(); const client = createNativeCaptionClient(b.port);
  const controller = new AbortController();
  const old = client.extract(videoId, { signal: controller.signal });
  controller.abort();
  await assert.rejects(old, { name: 'AbortError' });
  assert.deepEqual(b.sent.at(-1), { type: 'cancel', id: '1' });
  const next = client.extract(videoId);
  b.reply({ id: '1', ok: true, data: { ...payload, title: 'Stale' } });
  b.reply({ id: '2', ok: true, data: payload });
  assert.equal((await next).title, 'Video');
});

test('bot block, wrong-video response and malformed subtitles remain failures', async () => {
  const b = bridge(); const client = createNativeCaptionClient(b.port);
  const blocked = client.extract(videoId);
  b.reply({ id: '1', ok: false, reason: 'youtube_blocked', error: 'YouTube ellenőrzést kér.' });
  await assert.rejects(blocked, { reason: 'youtube_blocked' });
  const wrong = client.extract(videoId);
  b.reply({ id: '2', ok: true, data: { ...payload, videoId: 'abcdefghijk' } });
  await assert.rejects(wrong, /Másik videó/);
  const invalid = client.extract(videoId);
  b.reply({ id: '3', ok: true, data: { ...payload, vtt: '<html>Not a caption</html>' } });
  await assert.rejects(invalid);
});

test('stalled native extraction times out and sends cancellation', async () => {
  const b = bridge(); const client = createNativeCaptionClient(b.port, { timeoutMs: 15 });
  await assert.rejects(client.extract(videoId), { reason: 'timeout' });
  assert.deepEqual(b.sent.at(-1), { type: 'cancel', id: '1' });
});
