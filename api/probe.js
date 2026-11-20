// Ideiglenes diagnosztika (yt-probe ág): melyik YouTube-kliens éri el a feliratot a Vercelről.
const T = 8000;
const UA_WEB = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
function tfetch(url, opts = {}) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), T);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(id));
}
const CLIENTS = {
  ANDROID: { ctx: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 35, osName: "Android", osVersion: "15" }, ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 15) gzip", hdr: { "X-YouTube-Client-Name": "3", "X-YouTube-Client-Version": "20.10.38" } },
  IOS: { ctx: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82" }, ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)", hdr: { "X-YouTube-Client-Name": "5", "X-YouTube-Client-Version": "20.10.4" } },
  ANDROID_VR: { ctx: { clientName: "ANDROID_VR", clientVersion: "1.65.10", deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32, osName: "Android", osVersion: "12L" }, ua: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip", hdr: { "X-YouTube-Client-Name": "28", "X-YouTube-Client-Version": "1.65.10" } },
  WEB: { ctx: { clientName: "WEB", clientVersion: "2.20251119.01.00" }, ua: UA_WEB, hdr: { "X-YouTube-Client-Name": "1", "X-YouTube-Client-Version": "2.20251119.01.00", Origin: "https://www.youtube.com" } },
  MWEB: { ctx: { clientName: "MWEB", clientVersion: "2.20251119.01.00" }, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", hdr: { "X-YouTube-Client-Name": "2", "X-YouTube-Client-Version": "2.20251119.01.00", Origin: "https://m.youtube.com" } },
  WEB_EMBEDDED: { ctx: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20251119.01.00" }, ua: UA_WEB, hdr: { "X-YouTube-Client-Name": "56", "X-YouTube-Client-Version": "1.20251119.01.00", Origin: "https://www.youtube.com" }, extra: { thirdParty: { embedUrl: "https://www.google.com/" } } },
  TV: { ctx: { clientName: "TVHTML5", clientVersion: "7.20251119.13.00" }, ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version", hdr: { "X-YouTube-Client-Name": "7", "X-YouTube-Client-Version": "7.20251119.13.00", Origin: "https://www.youtube.com" } },
  TV_EMBEDDED: { ctx: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0" }, ua: "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko)", hdr: { "X-YouTube-Client-Name": "85", "X-YouTube-Client-Version": "2.0", Origin: "https://www.youtube.com" }, extra: { thirdParty: { embedUrl: "https://www.youtube.com/" } } }
};
async function probePlayer(v, name, c) {
  const out = { c: name };
  try {
    const body = { videoId: v, context: { client: { ...c.ctx, hl: "en", gl: "US" }, ...(c.extra || {}) }, contentCheckOk: true, racyCheckOk: true };
    const r = await tfetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": c.ua, ...c.hdr }, body: JSON.stringify(body) });
    out.http = r.status;
    const j = await r.json().catch(() => null);
    const ps = (j && j.playabilityStatus) || {};
    out.st = ps.status;
    if (ps.reason) out.why = String(ps.reason).slice(0, 60);
    const tracks = (j && j.captions && j.captions.playerCaptionsTracklistRenderer && j.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    out.tr = tracks.length;
    if (tracks.length) {
      const t = tracks.find((x) => String(x.languageCode || "").startsWith("en")) || tracks[0];
      const base = String(t.baseUrl || "");
      if (/[?&]exp=xpe/.test(base)) out.xpe = true;
      const u = base.replace(/&fmt=[^&]*/, "") + "&fmt=json3";
      const tr = await tfetch(u, { headers: { "User-Agent": c.ua } });
      const tx = await tr.text();
      out.dl = tr.status + ":" + tx.length;
    }
  } catch (e) {
    out.err = String((e && e.message) || e).slice(0, 80);
  }
  return out;
}
function findSegments(obj) {
  const segs = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.transcriptSegmentRenderer) {
      const s = o.transcriptSegmentRenderer;
      segs.push({ s: Number(s.startMs), e: Number(s.endMs), t: ((s.snippet && s.snippet.runs) || []).map((x) => x.text).join("") });
      return;
    }
    for (const k in o) walk(o[k]);
  };
  walk(obj);
  return segs;
}
async function probePanel(v) {
  const out = { c: "next+get_transcript" };
  const ver = "2.20251119.01.00";
  const headers = { "Content-Type": "application/json", "User-Agent": UA_WEB, "X-YouTube-Client-Name": "1", "X-YouTube-Client-Version": ver, Origin: "https://www.youtube.com" };
  const ctx = { client: { clientName: "WEB", clientVersion: ver, hl: "en", gl: "US" } };
  try {
    const r = await tfetch("https://www.youtube.com/youtubei/v1/next?prettyPrint=false", { method: "POST", headers, body: JSON.stringify({ videoId: v, context: ctx }) });
    const txt = await r.text();
    out.next = r.status + ":" + txt.length;
    let m = txt.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/);
    if (!m) {
      const w = await tfetch("https://www.youtube.com/watch?v=" + v + "&hl=en", { headers: { "User-Agent": UA_WEB, "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+cb; SOCS=CAI" } });
      const html = await w.text();
      out.watch = w.status + ":" + html.length;
      m = html.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/);
      if (m) out.paramsFrom = "watch";
    } else {
      out.paramsFrom = "next";
    }
    if (!m) return out;
    const r2 = await tfetch("https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false", { method: "POST", headers, body: JSON.stringify({ context: ctx, params: m[1] }) });
    out.gt = r2.status;
    const j2 = await r2.json().catch(() => null);
    const segs = findSegments(j2);
    out.segs = segs.length;
    if (segs[0]) out.first = segs[0].t.slice(0, 30);
    if (!segs.length && j2 && j2.error) out.gtErr = String(j2.error.message || j2.error.status || "").slice(0, 80);
  } catch (e) {
    out.err = String((e && e.message) || e).slice(0, 80);
  }
  return out;
}
async function probeAll(vids, only) {
  const results = {};
  for (const v of vids) {
    const rows = [];
    for (const [name, c] of Object.entries(CLIENTS)) {
      if (only && !only.includes(name)) continue;
      rows.push(await probePlayer(v, name, c));
    }
    if (!only || only.includes("PANEL")) rows.push(await probePanel(v));
    results[v] = rows;
  }
  return results;
}

export default async function handler(req, res) {
  const q = req.query || {};
  const vids = String(q.v || "BwwQaiAkus4,dQw4w9WgXcQ,arj7oStGLkU").split(",").filter(Boolean).slice(0, 4);
  const only = q.only ? String(q.only).split(",") : null;
  const t0 = Date.now();
  const results = await probeAll(vids, only);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ runtime: "node", region: process.env.VERCEL_REGION || null, ms: Date.now() - t0, results });
}
