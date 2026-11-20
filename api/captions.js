// Serverless function: fetches YouTube caption tracks and merges the cues.
// No npm dependencies (Node 22 built-in fetch).
// Every attempt is recorded in `diag`, written to the Vercel Runtime Log
// and returned in the error response, so a failure always has a visible reason.

const LOG = "[captions]";
const YT_TIMEOUT_MS = 8000;

const VIDEO_ID_PATTERNS = [
  /(?:youtube\.com\/watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/,
  /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  /(?:youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
  /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  /^([a-zA-Z0-9_-]{11})$/
];

const INNERTUBE_CLIENTS = {
  ANDROID: {
    client: {
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      androidSdkVersion: 35,
      osName: "Android",
      osVersion: "15",
      hl: "en",
      gl: "US"
    },
    ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 15) gzip"
  },
  IOS: {
    client: {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
      hl: "en",
      gl: "US"
    },
    ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)"
  },
  ANDROID_VR: {
    client: {
      clientName: "ANDROID_VR",
      clientVersion: "1.62.27",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      androidSdkVersion: 32,
      osName: "Android",
      osVersion: "12L",
      hl: "en",
      gl: "US"
    },
    ua: "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip"
  }
};

function extractVideoId(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  for (const re of VIDEO_ID_PATTERNS) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  return null;
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTrackArray(arr) {
  if (!Array.isArray(arr)) return [];
  const tracks = [];
  for (const obj of arr) {
    if (!obj) continue;
    const baseUrl = String(obj.baseUrl || "").replace(/\\u0026/g, "&");
    const langCode = String(obj.languageCode || "");
    if (!baseUrl || !langCode) continue;
    const langName = obj.name?.simpleText || obj.name?.runs?.[0]?.text || langCode;
    const isAuto = obj.kind === "asr";
    tracks.push({ baseUrl, langCode, langName, isAuto });
  }
  return tracks;
}

// Marks the attempt when YouTube refused it as bot traffic or age-gated it.
function classifyPlayability(entry, status, reason) {
  const text = `${status || ""} ${reason || ""}`;
  if (/not a bot|protect our community/i.test(text)) entry.blocked = true;
  if (/confirm your age|age-restricted|inappropriate for some users/i.test(text)) {
    entry.ageRestricted = true;
  }
  return entry;
}

async function fetchViaInnerTube(videoId, clientType, diag) {
  const cfg = INNERTUBE_CLIENTS[clientType];
  const entry = { step: `innertube:${clientType}` };
  diag.push(entry);
  try {
    const resp = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": cfg.ua,
        "Accept-Language": "en-US,en;q=0.9"
      },
      body: JSON.stringify({ videoId, context: { client: cfg.client } }),
      signal: AbortSignal.timeout(YT_TIMEOUT_MS)
    });
    entry.http = resp.status;
    if (resp.status === 429) entry.blocked = true;
    if (!resp.ok) return null;

    const data = await resp.json();
    const ps = data?.playabilityStatus || {};
    const tracks = parseTrackArray(data?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
    entry.playability = ps.status || null;
    if (ps.reason) entry.reason = String(ps.reason).slice(0, 160);
    entry.tracks = tracks.length;
    classifyPlayability(entry, ps.status, ps.reason);

    return {
      tracks,
      title: data?.videoDetails?.title || "",
      author: data?.videoDetails?.author || ""
    };
  } catch (err) {
    entry.error = String(err?.message || err).slice(0, 160);
    return null;
  }
}

function extractJsonArrayAfter(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const arrStart = html.indexOf("[", idx);
  if (arrStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = arrStart; i < html.length; i++) {
    const c = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) return JSON.parse(html.slice(arrStart, i + 1));
      }
    }
  }
  return null;
}

async function fetchViaWatchPage(videoId, diag) {
  const entry = { step: "watchpage" };
  diag.push(entry);
  try {
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "CONSENT=YES+cb; SOCS=CAI"
      },
      signal: AbortSignal.timeout(YT_TIMEOUT_MS)
    });
    entry.http = resp.status;
    if (resp.status === 429) entry.blocked = true;
    if (!resp.ok) return null;

    const html = await resp.text();
    if (/consent\.youtube\.com/.test(resp.url)) entry.consentWall = true;

    const psMatch = html.match(
      /"playabilityStatus":\{"status":"([A-Z_]+)"(?:,"reason":"((?:[^"\\]|\\.)*)")?/
    );
    if (psMatch) {
      entry.playability = psMatch[1];
      if (psMatch[2]) entry.reason = psMatch[2].slice(0, 160);
      classifyPlayability(entry, psMatch[1], psMatch[2]);
    }

    let title = "";
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch) {
      title = decodeHtmlEntities(titleMatch[1].replace(/\s*-\s*YouTube\s*$/i, ""));
    }

    const rawTracks = extractJsonArrayAfter(html, '"captionTracks":');
    const tracks = parseTrackArray(rawTracks);
    entry.tracks = tracks.length;
    return { tracks, title, author: "" };
  } catch (err) {
    entry.error = String(err?.message || err).slice(0, 160);
    return null;
  }
}

function supadataCuesFromContent(content) {
  return content
    .map((item) => {
      const start = Number(item.offset || 0) / 1000;
      const dur = Math.max(Number(item.duration || 3000) / 1000, 0.6);
      return { start, end: start + dur, text: decodeHtmlEntities(String(item.text || "")) };
    })
    .filter((c) => c.text);
}

// Supadata fallback (supadata.ai). mode=native: only existing YouTube captions,
// 1 credit per video, never the expensive AI transcription.
async function fetchViaSupadata(videoId, supadataKey, preferredLang, diag) {
  const entry = { step: "supadata" };
  diag.push(entry);
  const headers = { "x-api-key": supadataKey };
  const params = new URLSearchParams({
    url: `https://www.youtube.com/watch?v=${videoId}`,
    mode: "native"
  });
  if (preferredLang) params.set("lang", preferredLang);

  try {
    const resp = await fetch(`https://api.supadata.ai/v1/transcript?${params}`, {
      headers,
      signal: AbortSignal.timeout(25000)
    });
    entry.http = resp.status;
    let data = await resp.json().catch(() => null);

    // Long videos are processed as an async job: poll until it completes.
    if (resp.status === 202 && data?.jobId) {
      entry.jobId = data.jobId;
      const deadline = Date.now() + 35000;
      let done = false;
      while (!done && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const jr = await fetch(
          `https://api.supadata.ai/v1/transcript/${encodeURIComponent(data.jobId)}`,
          { headers, signal: AbortSignal.timeout(10000) }
        );
        const jd = await jr.json().catch(() => null);
        if (jd?.status === "completed") {
          data = jd.result || jd;
          done = true;
        } else if (jd?.status === "failed" || !jr.ok) {
          entry.error = String(jd?.error?.message || jd?.error || `job HTTP ${jr.status}`).slice(0, 160);
          return null;
        }
      }
      if (!done) {
        entry.error = "A Supadata feldolgozás nem készült el időben.";
        return null;
      }
    } else if (resp.status === 206) {
      entry.error = "A Supadata szerint ehhez a videóhoz nincs felirat.";
      return null;
    } else if (!resp.ok) {
      const msg = data?.message || data?.details || data?.error || `HTTP ${resp.status}`;
      entry.error = String(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 160);
      return null;
    }

    const content = Array.isArray(data?.content) ? data.content : [];
    entry.segments = content.length;
    if (!content.length) return null;

    const langCode = String(data.lang || content[0]?.lang || "en");
    return {
      cues: mergeShortCues(supadataCuesFromContent(content)),
      langCode,
      langName: langCode.toUpperCase(),
      isAuto: false
    };
  } catch (err) {
    entry.error = String(err?.message || err).slice(0, 160);
    return null;
  }
}

function selectBestTrack(tracks, preferredLang) {
  if (preferredLang) {
    const exact = tracks.find((t) => t.langCode.toLowerCase() === preferredLang.toLowerCase());
    if (exact) return exact;
  }
  return (
    tracks.find((t) => t.langCode.toLowerCase().startsWith("hu") && !t.isAuto) ||
    tracks.find((t) => t.langCode.toLowerCase().startsWith("hu")) ||
    tracks.find((t) => t.langCode.toLowerCase().startsWith("en") && !t.isAuto) ||
    tracks.find((t) => !t.isAuto) ||
    tracks.find((t) => t.langCode.toLowerCase().startsWith("en")) ||
    tracks[0]
  );
}

function parseJson3(body) {
  const cues = [];
  const root = JSON.parse(body);
  const events = Array.isArray(root?.events) ? root.events : [];
  for (const ev of events) {
    if (!Array.isArray(ev?.segs) || typeof ev.tStartMs !== "number") continue;
    const raw = ev.segs.map((s) => s.utf8 || "").join("");
    const text = decodeHtmlEntities(raw);
    if (!text) continue;
    const start = ev.tStartMs / 1000;
    const dur = Math.max((ev.dDurationMs || 3000) / 1000, 0.5);
    cues.push({ start, end: start + dur, text });
  }
  return cues;
}

function parseXmlCaptions(xml) {
  const cues = [];
  // Format 1: <text start="1.23" dur="3.45">...</text>
  const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = textRe.exec(xml)) !== null) {
    const attrs = m[1];
    const startMatch = attrs.match(/start="([^"]+)"/i);
    const durMatch = attrs.match(/dur="([^"]+)"/i);
    const start = parseFloat(startMatch?.[1] || "0");
    const dur = Math.max(parseFloat(durMatch?.[1] || "3"), 0.5);
    const text = decodeHtmlEntities(m[2]);
    if (text) cues.push({ start, end: start + dur, text });
  }
  if (cues.length > 0) return cues;

  // Format 2: srv3 <p t="1230" d="3450">...</p>
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  while ((m = pRe.exec(xml)) !== null) {
    const attrs = m[1];
    const tMatch = attrs.match(/\bt="([^"]+)"/i);
    const dMatch = attrs.match(/\bd="([^"]+)"/i);
    if (!tMatch) continue;
    const start = parseFloat(tMatch[1]) / 1000;
    const dur = Math.max(parseFloat(dMatch?.[1] || "3000") / 1000, 0.5);
    const text = decodeHtmlEntities(m[2]);
    if (text) cues.push({ start, end: start + dur, text });
  }
  return cues;
}

async function downloadTrackCues(baseUrl, diag) {
  const ua = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36";
  const json3Url = baseUrl.includes("fmt=")
    ? baseUrl.replace(/fmt=[^&]+/, "fmt=json3")
    : `${baseUrl}&fmt=json3`;

  const jsonEntry = { step: "timedtext:json3" };
  diag.push(jsonEntry);
  try {
    const resp = await fetch(json3Url, {
      headers: { "User-Agent": ua },
      signal: AbortSignal.timeout(YT_TIMEOUT_MS)
    });
    jsonEntry.http = resp.status;
    if (resp.status === 429) jsonEntry.blocked = true;
    if (resp.ok) {
      const text = await resp.text();
      jsonEntry.bytes = text.length;
      if (text.trim().startsWith("{")) {
        const parsed = parseJson3(text);
        jsonEntry.cues = parsed.length;
        if (parsed.length > 0) return parsed;
      }
    }
  } catch (err) {
    jsonEntry.error = String(err?.message || err).slice(0, 160);
  }

  const xmlEntry = { step: "timedtext:xml" };
  diag.push(xmlEntry);
  try {
    const resp = await fetch(baseUrl, {
      headers: { "User-Agent": ua },
      signal: AbortSignal.timeout(YT_TIMEOUT_MS)
    });
    xmlEntry.http = resp.status;
    if (resp.status === 429) xmlEntry.blocked = true;
    if (!resp.ok) return [];
    const xml = await resp.text();
    xmlEntry.bytes = xml.length;
    const parsed = parseXmlCaptions(xml);
    xmlEntry.cues = parsed.length;
    return parsed;
  } catch (err) {
    xmlEntry.error = String(err?.message || err).slice(0, 160);
    return [];
  }
}

function mergeShortCues(raw) {
  if (!raw.length) return [];
  const merged = [];
  let curStart = raw[0].start;
  let curEnd = raw[0].end;
  let curText = raw[0].text;

  for (let i = 1; i < raw.length; i++) {
    const next = raw[i];
    const gap = next.start - curEnd;
    const combinedDur = next.end - curStart;
    const endsSentence = /[.?!…]$/.test(curText);
    const combinedLen = curText.length + 1 + next.text.length;

    if (!endsSentence && gap <= 0.85 && combinedDur <= 5.8 && combinedLen <= 98) {
      curText = `${curText} ${next.text}`;
      curEnd = Math.max(curEnd, next.end);
    } else {
      const safeEnd = Math.max(curStart + 0.6, Math.min(curEnd, next.start));
      merged.push({
        start: Number(curStart.toFixed(2)),
        end: Number(safeEnd.toFixed(2)),
        text: curText
      });
      curStart = next.start;
      curEnd = next.end;
      curText = next.text;
    }
  }

  merged.push({
    start: Number(curStart.toFixed(2)),
    end: Number(Math.max(curEnd, curStart + 1.0).toFixed(2)),
    text: curText
  });
  return merged;
}

// Turns the attempt log into one Hungarian sentence for the app's status line.
function describeFailure(diag, hadSupadataKey) {
  const yt = diag.filter((d) => d.step !== "supadata");
  const supa = diag.find((d) => d.step === "supadata");
  const supaNote = supa?.error ? ` Supadata: ${supa.error}` : "";

  if (yt.some((d) => d.blocked)) {
    if (hadSupadataKey) {
      return {
        reason: "youtube_blocked",
        status: 502,
        message:
          "A YouTube letiltotta a felirat lekérését a Vercel szerveréről, és a Supadata tartalék sem adott feliratot." +
          supaNote
      };
    }
    return {
      reason: "youtube_blocked",
      status: 502,
      message:
        "A YouTube ennél a videónál nem engedi a felirat letöltését a Vercel szerveréről („Sign in to confirm you're not a bot”), " +
        "mert a kérés adatközponti IP-címről jön. Megoldás: ingyenes Supadata API-kulcs (supadata.ai, havi 100 videó) a " +
        "Beállítások → Haladó / Tartalék feliratletöltő mezőben."
    };
  }
  if (yt.some((d) => d.ageRestricted)) {
    return {
      reason: "age_restricted",
      status: 403,
      message: "Korhatáros videó: a YouTube bejelentkezést kér, ezért a szerver nem éri el a feliratát." + supaNote
    };
  }
  if (yt.some((d) => d.playability === "ERROR" || d.playability === "UNPLAYABLE")) {
    return {
      reason: "unavailable",
      status: 404,
      message: "A videó nem érhető el (privát, törölt vagy régióhoz kötött)." + supaNote
    };
  }
  if (yt.some((d) => (d.tracks || 0) > 0)) {
    return {
      reason: "download_failed",
      status: 502,
      message:
        "A feliratsávok listája megjött, de a letöltésük üres választ adott (a YouTube korlátozza a szervert)." +
        supaNote
    };
  }
  if (yt.some((d) => d.playability === "OK")) {
    return {
      reason: "no_captions",
      status: 404,
      message: "Ehhez a videóhoz nincs felirat a YouTube-on (sem kézi, sem automatikus)." + supaNote
    };
  }
  return {
    reason: "unknown",
    status: 502,
    message: "Nem sikerült letölteni a feliratot ehhez a videóhoz." + supaNote
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const body = req.method === "POST" && req.body && typeof req.body === "object" ? req.body : {};
  const query = req.query || {};
  const input = body.videoId || body.url || query.videoId || query.url;
  const preferredLang = body.lang || query.lang || "";
  const supadataKey = body.supadataKey || process.env.SUPADATA_API_KEY || "";

  const videoId = extractVideoId(input);
  if (!videoId) {
    return res.status(400).json({ error: "Érvénytelen YouTube-link vagy videóazonosító." });
  }

  const diag = [];
  const region = process.env.VERCEL_REGION || "local";
  let title = "";
  let author = "";
  let tracks = [];

  for (const clientType of ["ANDROID", "IOS", "ANDROID_VR"]) {
    const r = await fetchViaInnerTube(videoId, clientType, diag);
    if (r) {
      title = title || r.title;
      author = author || r.author;
      if (r.tracks.length > 0) {
        tracks = r.tracks;
        break;
      }
    }
    // A bot check is tied to the server's IP: every other client and the watch page get the
    // same answer (verified on 2026-11-20 from iad1, fra1 and hnd1), so skip straight on.
    if (diag[diag.length - 1]?.blocked) break;
  }

  if (tracks.length === 0 && !diag.some((d) => d.blocked)) {
    const watchRes = await fetchViaWatchPage(videoId, diag);
    if (watchRes) {
      title = title || watchRes.title;
      if (watchRes.tracks.length > 0) tracks = watchRes.tracks;
    }
  }

  if (tracks.length > 0) {
    const chosen = selectBestTrack(tracks, preferredLang);
    const rawCues = await downloadTrackCues(chosen.baseUrl, diag);
    if (rawCues.length > 0) {
      const cues = mergeShortCues(rawCues);
      console.log(LOG, JSON.stringify({ videoId, region, outcome: "ok:youtube", cues: cues.length, diag }));
      return res.status(200).json({
        videoId,
        title,
        author,
        source: "youtube",
        selectedTrack: {
          langCode: chosen.langCode,
          langName: chosen.langName,
          isAuto: chosen.isAuto
        },
        tracks: tracks.map((t) => ({ langCode: t.langCode, langName: t.langName, isAuto: t.isAuto })),
        alreadyHungarian: chosen.langCode.toLowerCase().startsWith("hu"),
        cues
      });
    }
  }

  if (supadataKey) {
    const supaRes = await fetchViaSupadata(videoId, supadataKey, preferredLang, diag);
    if (supaRes && supaRes.cues.length > 0) {
      console.log(
        LOG,
        JSON.stringify({ videoId, region, outcome: "ok:supadata", cues: supaRes.cues.length, diag })
      );
      return res.status(200).json({
        videoId,
        title,
        author,
        source: "supadata",
        selectedTrack: {
          langCode: supaRes.langCode,
          langName: supaRes.langName,
          isAuto: supaRes.isAuto
        },
        tracks: [{ langCode: supaRes.langCode, langName: supaRes.langName, isAuto: supaRes.isAuto }],
        alreadyHungarian: supaRes.langCode.toLowerCase().startsWith("hu"),
        cues: supaRes.cues
      });
    }
  }

  const failure = describeFailure(diag, Boolean(supadataKey));
  console.warn(LOG, JSON.stringify({ videoId, region, outcome: failure.reason, diag }));
  return res.status(failure.status).json({
    error: failure.message,
    reason: failure.reason,
    region,
    details: diag
  });
}
