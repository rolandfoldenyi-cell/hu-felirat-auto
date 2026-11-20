// Serverless function: extracts and merges YouTube subtitle cues automatically.
// Zero external npm dependencies (uses Node 20 built-in fetch).

const VIDEO_ID_PATTERNS = [
  /(?:youtube\.com\/watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/,
  /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  /(?:youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
  /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  /^([a-zA-Z0-9_-]{11})$/
];

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
    const langName =
      obj.name?.simpleText ||
      obj.name?.runs?.[0]?.text ||
      langCode;
    const isAuto = obj.kind === "asr";
    tracks.push({ baseUrl, langCode, langName, isAuto });
  }
  return tracks;
}

async function fetchViaInnerTube(videoId, clientType) {
  const clientConfig =
    clientType === "IOS"
      ? {
          client: {
            clientName: "IOS",
            clientVersion: "20.10.4",
            deviceModel: "iPhone16,2",
            hl: "en",
            gl: "US"
          },
          ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)"
        }
      : {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.10.38",
            androidSdkVersion: 35,
            hl: "en",
            gl: "US"
          },
          ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 15) gzip"
        };

  try {
    const resp = await fetch(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": clientConfig.ua,
          "Accept-Language": "en-US,en;q=0.9"
        },
        body: JSON.stringify({
          videoId,
          context: { client: clientConfig.client }
        })
      }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const tracks = parseTrackArray(
      data?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    );
    const title = data?.videoDetails?.title || "";
    const author = data?.videoDetails?.author || "";
    return { tracks, title, author };
  } catch {
    return null;
  }
}

async function fetchViaWatchPage(videoId) {
  try {
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "CONSENT=YES+cb"
      }
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    let title = "";
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch) {
      title = decodeHtmlEntities(titleMatch[1].replace(/\s*-\s*YouTube\s*$/i, ""));
    }

    const marker = '"captionTracks":';
    const idx = html.indexOf(marker);
    if (idx === -1) return { tracks: [], title, author: "" };

    const arrStart = html.indexOf("[", idx);
    if (arrStart === -1) return { tracks: [], title, author: "" };

    let depth = 0;
    let inString = false;
    let escape = false;
    let arrEnd = -1;

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
          if (depth === 0) {
            arrEnd = i;
            break;
          }
        }
      }
    }

    if (arrEnd === -1) return { tracks: [], title, author: "" };
    const rawTracks = JSON.parse(html.slice(arrStart, arrEnd + 1));
    return { tracks: parseTrackArray(rawTracks), title, author: "" };
  } catch {
    return null;
  }
}

async function fetchViaSupadata(videoId, supadataKey) {
  if (!supadataKey) return null;
  try {
    const resp = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?videoId=${encodeURIComponent(videoId)}`,
      {
        headers: {
          "x-api-key": supadataKey
        }
      }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const content = Array.isArray(data?.content) ? data.content : [];
    if (!content.length) return null;
    const cues = content
      .map((item) => {
        const start = Number(item.offset || 0) / 1000;
        const dur = Math.max(Number(item.duration || 3000) / 1000, 0.6);
        return {
          start,
          end: start + dur,
          text: decodeHtmlEntities(String(item.text || ""))
        };
      })
      .filter((c) => c.text);

    const langCode = String(data.lang || "en");
    return {
      cues: mergeShortCues(cues),
      langCode,
      langName: langCode.toUpperCase(),
      isAuto: false
    };
  } catch {
    return null;
  }
}

function selectBestTrack(tracks, preferredLang) {
  if (preferredLang) {
    const exact = tracks.find(
      (t) => t.langCode.toLowerCase() === preferredLang.toLowerCase()
    );
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

async function downloadTrackCues(baseUrl) {
  const json3Url = baseUrl.includes("fmt=")
    ? baseUrl.replace(/fmt=[^&]+/, "fmt=json3")
    : `${baseUrl}&fmt=json3`;

  try {
    const resp = await fetch(json3Url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36"
      }
    });
    if (resp.ok) {
      const text = await resp.text();
      if (text.trim().startsWith("{")) {
        const parsed = parseJson3(text);
        if (parsed.length > 0) return parsed;
      }
    }
  } catch {
    // Fallback to XML below
  }

  try {
    const resp = await fetch(baseUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36"
      }
    });
    if (!resp.ok) return [];
    const xml = await resp.text();
    return parseXmlCaptions(xml);
  } catch {
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const input =
    req.method === "POST"
      ? req.body?.videoId || req.body?.url
      : req.query?.videoId || req.query?.url;
  const preferredLang =
    req.method === "POST" ? req.body?.lang : req.query?.lang;
  const supadataKey =
    req.method === "POST"
      ? req.body?.supadataKey || process.env.SUPADATA_API_KEY || ""
      : process.env.SUPADATA_API_KEY || "";

  const videoId = extractVideoId(input);
  if (!videoId) {
    return res.status(400).json({ error: "Érvénytelen YouTube-link vagy videóazonosító." });
  }

  let title = "";
  let author = "";
  let tracks = [];

  // Tier 1: InnerTube ANDROID
  const androidRes = await fetchViaInnerTube(videoId, "ANDROID");
  if (androidRes) {
    title = androidRes.title || title;
    author = androidRes.author || author;
    if (androidRes.tracks.length > 0) tracks = androidRes.tracks;
  }

  // Tier 2: InnerTube IOS
  if (tracks.length === 0) {
    const iosRes = await fetchViaInnerTube(videoId, "IOS");
    if (iosRes) {
      title = title || iosRes.title;
      author = author || iosRes.author;
      if (iosRes.tracks.length > 0) tracks = iosRes.tracks;
    }
  }

  // Tier 3: Watch Page HTML
  if (tracks.length === 0) {
    const watchRes = await fetchViaWatchPage(videoId);
    if (watchRes) {
      title = title || watchRes.title;
      if (watchRes.tracks.length > 0) tracks = watchRes.tracks;
    }
  }

  if (tracks.length > 0) {
    const chosen = selectBestTrack(tracks, preferredLang);
    const rawCues = await downloadTrackCues(chosen.baseUrl);
    if (rawCues.length > 0) {
      const cues = mergeShortCues(rawCues);
      const alreadyHungarian = chosen.langCode.toLowerCase().startsWith("hu");
      return res.status(200).json({
        videoId,
        title,
        author,
        selectedTrack: {
          langCode: chosen.langCode,
          langName: chosen.langName,
          isAuto: chosen.isAuto
        },
        tracks: tracks.map((t) => ({
          langCode: t.langCode,
          langName: t.langName,
          isAuto: t.isAuto
        })),
        alreadyHungarian,
        cues
      });
    }
  }

  // Tier 4: Optional Supadata backup
  if (supadataKey) {
    const supaRes = await fetchViaSupadata(videoId, supadataKey);
    if (supaRes && supaRes.cues.length > 0) {
      const alreadyHungarian = supaRes.langCode.toLowerCase().startsWith("hu");
      return res.status(200).json({
        videoId,
        title,
        author,
        selectedTrack: {
          langCode: supaRes.langCode,
          langName: supaRes.langName,
          isAuto: supaRes.isAuto
        },
        tracks: [
          {
            langCode: supaRes.langCode,
            langName: supaRes.langName,
            isAuto: supaRes.isAuto
          }
        ],
        alreadyHungarian,
        cues: supaRes.cues
      });
    }
  }

  return res.status(404).json({
    error:
      "Nem sikerült letölteni a feliratsávot ehhez a videóhoz (lehet, hogy nincs alapfelirata, vagy a YouTube korlátozta a szerver lekérdezését). A Beállítások → Tartalék opcióval vagy egy másik videóval is megpróbálhatod."
  });
}
