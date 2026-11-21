import { parseTimedSubtitles } from './subtitle-files.js';

// Only the Android app's top-level trusted origin receives this message port.
// A YouTube iframe never receives a native interface.
export function createNativeCaptionClient(port, { timeoutMs = 20 * 60 * 1000 } = {}) {
  const pending = new Map();
  let sequence = 0;
  port.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const job = pending.get(message.id);
    if (!job) return;
    if (message.type === 'progress') { job.onProgress?.(message); return; }
    if (!message.ok) {
      const error = new Error(message.error || 'A telefonos feliratletöltés nem sikerült.');
      error.reason = message.reason || 'extractor_error';
      error.diagnostic = message.diagnostic || '';
      job.finish(error);
      return;
    }
    try {
      const data = message.data;
      if (!data || data.videoId !== job.videoId) throw new Error('Másik videóhoz érkezett felirat.');
      const cues = parseTimedSubtitles(data.vtt);
      if (!cues.length || cues.some(c => !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start)) {
        throw new Error('A letöltött felirat időzítése hibás.');
      }
      job.finish(null, { ...data, vtt: undefined, cues,
        alreadyHungarian: String(data.selectedTrack?.langCode || '').toLowerCase().startsWith('hu') });
    } catch (error) { job.finish(error); }
  };
  return {
    extract(videoId, { lang = 'en', signal, onProgress } = {}) {
      signal?.throwIfAborted();
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return Promise.reject(new Error('Érvénytelen videóazonosító.'));
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        const cancel = () => { try { port.postMessage(JSON.stringify({ type: 'cancel', id })); } catch {} };
        const onAbort = () => { cancel(); finish(signal.reason || new DOMException('Megszakítva', 'AbortError')); };
        const finish = (error, data) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          error ? reject(error) : resolve(data);
        };
        const timer = setTimeout(() => {
          cancel();
          const error = new Error('A telefonos feliratletöltés túllépte az időkorlátot. Próbáld újra.');
          error.reason = 'timeout';
          finish(error);
        }, timeoutMs);
        pending.set(id, { videoId, finish, onProgress });
        signal?.addEventListener('abort', onAbort, { once: true });
        try { port.postMessage(JSON.stringify({ type: 'extract', id, videoId, lang })); }
        catch (error) { finish(error); }
      });
    }
  };
}

export const nativeCaptionClient = typeof globalThis.HUCaptionNative?.postMessage === 'function'
  ? createNativeCaptionClient(globalThis.HUCaptionNative) : null;
