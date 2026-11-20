import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimedSubtitles } from '../public/subtitle-files.js';

test('phone SRT files handle BOM, CRLF, milliseconds, multiline text and markup',()=>{
  const cues=parseTimedSubtitles('\uFEFF1\r\n00:00:01,250 --> 00:00:04,500\r\n<i>Hello</i> &amp;\r\nwelcome.\r\n');
  assert.deepEqual(cues,[{start:1.25,end:4.5,text:'Hello & welcome.'}]);
});

test('WebVTT headers, comments, cue identifiers and positioning are handled',()=>{
  const cues=parseTimedSubtitles('WEBVTT\n\nNOTE a comment\n00:00.000 --> 00:03.000\nignore this\n\ncue-1\n00:01.200 --> 00:03.900 align:start\n<v Speaker><c.red>A line</c></v>\n\ncue-2\n00:04.000 --> 00:05.000\nSecond line');
  assert.deepEqual(cues,[{start:1.2,end:3.9,text:'A line'},{start:4,end:5,text:'Second line'}]);
});

test('invalid timing is ignored and valid cues are sorted without losing alignment',()=>{
  const cues=parseTimedSubtitles('1\n00:00:05,000 --> 00:00:07,000\nLater\n\n2\n00:00:02,000 --> 00:00:01,000\nInvalid\n\n3\n00:99:00,000 --> 00:99:01,000\nInvalid\n\n4\n00:00:01,000 --> 00:00:02,000\nFirst');
  assert.deepEqual(cues.map(cue=>cue.text),['First','Later']);
});

test('empty or untimed content fails before playback is changed',()=>{
  for(const input of ['', 'A transcript without any timestamps.', '1\n00:00:04,000 --> 00:00:01,000\nInvalid']) {
    assert.throws(()=>parseTimedSubtitles(input));
  }
});

test('encoded text remains text and invalid Unicode entities do not crash the app',()=>{
  const [cue]=parseTimedSubtitles('1\n00:00:00,000 --> 00:00:01,000\n&lt;img src=x onerror=alert(1)&gt; &#x1F642; &#999999999999;');
  assert.equal(cue.text,'<img src=x onerror=alert(1)> 🙂');
});

test('oversized subtitle input is rejected',()=>{
  assert.throws(()=>parseTimedSubtitles('a'.repeat(2*1024*1024+1)),/2 MB/);
});
