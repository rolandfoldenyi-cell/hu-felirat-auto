import { parseTimedSubtitles } from "/subtitle-files.js";
import { createChromeSession, translateByPriority } from "/translation-priority.js";

// HU Felirat Auto PWA — Automatic YouTube caption fetch + progressive Hungarian translation

const STORAGE_SETTINGS = "hufelirat_auto_settings_v2";
const STORAGE_HISTORY = "hufelirat_auto_history_v2";

const state = {
  settings: loadSettings(),
  videoId: null,
  title: "",
  sourceLanguage: "",
  sourceLangName: "",
  chromeSession: null,
  chromeAttempted: false,
  deepLDisabled: false,
  tracks: [],
  cues: [], // { start, end, original, translated }
  activeCueIndex: -1,
  ytPlayer: null,
  ytApiReady: typeof window.YT?.Player === "function",
  pendingVideoId: null,
  pendingPlayerOptions: {},
  nativeCaptionMode: false,
  loadEpoch: 0,
  pollTimer: null,
  isSeeking: false,
  translationAbortController: null,
  deferredInstallPrompt: null,
  userScrollingTranscriptUntil: 0
};

// DOM elements
const els = {
  btnInstall: document.getElementById("btnInstall"),
  badgeInstalled: document.getElementById("badgeInstalled"),
  btnSettings: document.getElementById("btnSettings"),
  heroSection: document.getElementById("heroSection"),
  urlInput: document.getElementById("urlInput"),
  btnPaste: document.getElementById("btnPaste"),
  btnLoad: document.getElementById("btnLoad"),
  videoMeta: document.getElementById("videoMeta"),
  videoTitle: document.getElementById("videoTitle"),
  trackSelect: document.getElementById("trackSelect"),
  playerCard: document.getElementById("playerCard"),
  playerStage: document.getElementById("playerStage"),
  btnExitFs: document.getElementById("btnExitFs"),
  subHu: document.getElementById("subHu"),
  subOrig: document.getElementById("subOrig"),
  timeCurrent: document.getElementById("timeCurrent"),
  timeDuration: document.getElementById("timeDuration"),
  seekBar: document.getElementById("seekBar"),
  btnBack5: document.getElementById("btnBack5"),
  btnPlayPause: document.getElementById("btnPlayPause"),
  btnFwd5: document.getElementById("btnFwd5"),
  btnFullscreen: document.getElementById("btnFullscreen"),
  btnBilingual: document.getElementById("btnBilingual"),
  btnFontDown: document.getElementById("btnFontDown"),
  btnFontUp: document.getElementById("btnFontUp"),
  btnRetranslate: document.getElementById("btnRetranslate"),
  statusSpinner: document.getElementById("statusSpinner"),
  statusText: document.getElementById("statusText"),
  transcriptCard: document.getElementById("transcriptCard"),
  cueCounter: document.getElementById("cueCounter"),
  transcriptList: document.getElementById("transcriptList"),
  historyCard: document.getElementById("historyCard"),
  historyList: document.getElementById("historyList"),
  btnClearHistory: document.getElementById("btnClearHistory"),
  settingsModal: document.getElementById("settingsModal"),
  btnCloseSettings: document.getElementById("btnCloseSettings"),
  btnSaveSettings: document.getElementById("btnSaveSettings"),
  inputDeepLKey: document.getElementById("inputDeepLKey"),
  inputDeepLPlan: document.getElementById("inputDeepLPlan"),
  btnEnableChrome: document.getElementById("btnEnableChrome"),
  btnCaptionFallback: document.getElementById("btnCaptionFallback"),
  inputSupadataKey: document.getElementById("inputSupadataKey"),
  freeOptions: document.getElementById("freeOptions"),
  captionNotice: document.getElementById("captionNotice"),
  btnNativeCaptions: document.getElementById("btnNativeCaptions"),
  openYouTube: document.getElementById("openYouTube"),
  subtitleFile: document.getElementById("subtitleFile"),
  subtitleText: document.getElementById("subtitleText"),
  importLanguage: document.getElementById("importLanguage"),
  btnImportText: document.getElementById("btnImportText"),
  subtitleStage: document.getElementById("subtitleStage"),
  ytPlayerHost: document.getElementById("ytPlayerHost")
};

// ---------------- Settings & History ----------------

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_SETTINGS) || "{}");
    return {
      engine: "browser_free",
      deeplKey: raw.deeplKey || "",
      deeplPlan: raw.deeplPlan === "legacy_free" ? "legacy_free" : "developer",
      supadataKey: raw.supadataKey || "",
      bilingual: Boolean(raw.bilingual),
      fontSize: Number(raw.fontSize) || 18
    };
  } catch {
    return {
      engine: "browser_free",
      deeplKey: "",
      deeplPlan: "developer",
      supadataKey: "",
      bilingual: false,
      fontSize: 18
    };
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(state.settings));
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_HISTORY) || "[]");
  } catch {
    return [];
  }
}

function addToHistory(videoId, title) {
  const list = loadHistory().filter((item) => item.videoId !== videoId);
  list.unshift({
    videoId,
    title: title || `YouTube videó (${videoId})`,
    url: `https://www.youtube.com/watch?v=${videoId}`
  });
  localStorage.setItem(STORAGE_HISTORY, JSON.stringify(list.slice(0, 8)));
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  if (!list.length) {
    els.historyCard.hidden = true;
    return;
  }
  els.historyCard.hidden = false;
  els.historyList.innerHTML = "";
  for (const item of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "history-item";
    btn.innerHTML = `<span>▶ ${escapeHtml(item.title)}</span>`;
    btn.addEventListener("click", () => {
      els.urlInput.value = item.url;
      loadVideoFromInput(item.url);
    });
    els.historyList.appendChild(btn);
  }
}

// ---------------- Helpers ----------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractVideoId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  return null;
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }
  return `${m}:${String(rem).padStart(2, "0")}`;
}

function setStatus(text, { loading = false, error = false } = {}) {
  els.statusSpinner.hidden = !loading;
  els.statusText.textContent = text;
  els.statusText.classList.toggle("error", error);
}

// Reads a JSON API response; a non-JSON body (e.g. a Vercel 404 page) becomes a readable error.
async function readJsonResponse(resp) {
  const raw = await resp.text();
  try {
    return JSON.parse(raw);
  } catch {
    const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 60);
    throw new Error(
      `A szerver nem JSON-választ adott (HTTP ${resp.status}${snippet ? `: ${snippet}` : ""}). ` +
        "Valószínűleg nem települt az API-függvény."
    );
  }
}

function engineLabel(engine) {
  if (engine === "chrome") return "Chrome beépített fordító";
  if (engine === "deepl") return "DeepL tartalék";
  if (engine === "browser_free") return "Chrome / ingyenes Google";
  return "Google Translate";
}

// ---------------- Google Translate directly from the phone ----------------
// translate.googleapis.com accepts cross-origin requests, so the free engine runs on the
// phone's own connection instead of the shared Vercel IP that Google rate-limits.
// /api/translate stays as the fallback.

const GT_URL = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=hu&dt=t&q=";

async function googleRaw(text, signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await fetch(GT_URL + encodeURIComponent(text), { signal });
    if (resp.ok) {
      const data = await resp.json();
      const segments = Array.isArray(data?.[0]) ? data[0] : [];
      return segments.map((s) => (Array.isArray(s) ? s[0] || "" : "")).join("");
    }
    if (resp.status !== 429 && resp.status < 500) break;
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  throw new Error("A Google Fordító nem válaszolt.");
}

// Lines of three or more words: if one comes back unchanged, it was not translated.
const MULTIWORD = /\p{L}{2,}[^\p{L}]+\p{L}{2,}[^\p{L}]+\p{L}{2,}/u;
const untranslatedIdx = (lines, out) =>
  lines
    .map((src, i) => (MULTIWORD.test(src) && out[i].trim().toLowerCase() === src.trim().toLowerCase() ? i : -1))
    .filter((i) => i >= 0);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Lines are joined with plain line breaks: Google returns one output line per input line.
async function googleBatch(lines, signal) {
  const parts = (await googleRaw(lines.join("\n"), signal)).split("\n");
  return parts.length === lines.length ? parts.map((p, i) => p.trim() || lines[i]) : null;
}

// Google now and then answers with the source text echoed back: unchanged lines get one
// more try, together in a single request.
async function translateGoogleDirect(lines, signal) {
  let result = await googleBatch(lines, signal);
  if (!result) {
    result = await mapLimit(lines, 3, (line) =>
      googleRaw(line, signal)
        .then((t) => t.trim() || line)
        .catch((err) => {
          if (err.name === "AbortError") throw err;
          return line;
        })
    );
  }
  const retryIdx = untranslatedIdx(lines, result);
  if (retryIdx.length) {
    await new Promise((r) => setTimeout(r, 400));
    const again = await googleBatch(retryIdx.map((i) => lines[i]), signal).catch((err) => {
      if (err.name === "AbortError") throw err;
      return null;
    });
    if (again) {
      retryIdx.forEach((lineIdx, k) => {
        result[lineIdx] = again[k];
      });
    }
  }
  const failed = untranslatedIdx(lines, result).length;
  const eligible = lines.filter((l) => MULTIWORD.test(l)).length;
  if (eligible > 0 && failed === eligible) {
    throw new Error("A Google Fordító egy sort sem fordított le.");
  }
  return { engine: "google_free", translations: result, failed };
}

async function requestServerTranslation(texts, engine, signal) {
  const resp = await fetch("/api/translate", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ texts, engine,
      ...(engine === "deepl" ? {
        deeplKey: state.settings.deeplKey, deeplPlan: state.settings.deeplPlan
      } : {})
    })
  });
  const data = await readJsonResponse(resp);
  if (!resp.ok) throw new Error(data.error || "Fordítási hiba.");
  return data;
}

async function chromeBatch(texts, signal) {
  if (!state.chromeAttempted) {
    state.chromeAttempted = true;
    try {
      state.chromeSession = await createChromeSession(state.sourceLanguage, {
        signal, onProgress: (progress) => setStatus(
          "Chrome nyelvi csomag letöltése: " + Math.round(progress * 100) + "%", { loading: true })
      });
    } catch (error) {
      if (error.name === "NotAllowedError") els.btnEnableChrome.hidden = false;
      throw error;
    }
  }
  if (!state.chromeSession) throw new Error("A Chrome beépített fordítója ezen az eszközön nem elérhető.");
  const translations = [];
  for (const text of texts) {
    signal.throwIfAborted();
    translations.push(await state.chromeSession.translate(text));
  }
  return { translations };
}

async function translateBatch(texts, activeEngine, signal) {
  return translateByPriority(texts, {
    signal,
    chromeTranslate: globalThis.Translator ? chromeBatch : null,
    googleTranslate: async (lines) => {
      try { return await translateGoogleDirect(lines, signal); }
      catch (error) {
        signal.throwIfAborted();
        if (error.name === "AbortError") throw error;
        return requestServerTranslation(lines, "google_free", signal);
      }
    },
    deepLTranslate: state.settings.deeplKey && !state.deepLDisabled ? async (lines) => {
      try { return await requestServerTranslation(lines, "deepl", signal); }
      catch (error) { state.deepLDisabled = true; throw error; }
    } : null
  });
}

async function restartTranslation(enableChrome = false) {
  if (!state.cues.length) return;
  if (state.sourceLanguage.toLowerCase().startsWith("hu")) {
    setStatus(`Kész — eredeti magyar felirat betöltve (${state.cues.length} sor).`);
    return;
  }
  state.translationAbortController?.abort();
  const controller = new AbortController();
  state.translationAbortController = controller;
  state.chromeSession?.destroy();
  state.chromeSession = null;
  state.chromeAttempted = false;
  state.deepLDisabled = false;
  try {
    if (enableChrome) {
      // Runs inside the click handler, so Chrome may download its language pack.
      state.chromeSession = await createChromeSession(state.sourceLanguage, { signal: controller.signal });
      controller.signal.throwIfAborted();
      state.chromeAttempted = true;
      els.btnEnableChrome.hidden = Boolean(state.chromeSession);
    }
    await translateAllProgressive(controller.signal, state.sourceLangName);
  } catch (error) {
    if (error.name !== "AbortError") setStatus(error.message, { error: true });
  }
}

function applySubtitleStyle() {
  els.btnBilingual.textContent = state.settings.bilingual ? "Kétnyelvű: BE" : "Kétnyelvű: KI";
  els.btnBilingual.classList.toggle("active", state.settings.bilingual);
  els.subHu.style.fontSize = `${state.settings.fontSize}px`;
  els.subOrig.style.fontSize = `${Math.max(11, state.settings.fontSize - 4)}px`;
  els.subOrig.hidden = !state.settings.bilingual;
}

// ---------------- YouTube IFrame API ----------------

window.onYouTubeIframeAPIReady = function () {
  state.ytApiReady = true;
  if (state.pendingVideoId) {
    mountOrLoadPlayer(state.pendingVideoId, state.pendingPlayerOptions);
    state.pendingVideoId = null;
  }
};

function mountOrLoadPlayer(videoId, { nativeCaptions = false, startSeconds = 0 } = {}) {
  if (!state.ytApiReady || typeof YT === "undefined" || !YT.Player) {
    state.pendingVideoId = videoId;
    state.pendingPlayerOptions = { nativeCaptions, startSeconds };
    return;
  }

  if (state.ytPlayer && typeof state.ytPlayer.loadVideoById === "function") {
    if (state.nativeCaptionMode === nativeCaptions) {
      state.ytPlayer.loadVideoById({ videoId, startSeconds });
      return;
    }
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.ytPlayer.destroy();
    state.ytPlayer = null;
    const mount = document.createElement("div");
    mount.id = "ytPlayerMount";
    els.ytPlayerHost.replaceChildren(mount);
  }
  state.nativeCaptionMode = nativeCaptions;

  state.ytPlayer = new YT.Player("ytPlayerMount", {
    videoId,
    playerVars: {
      autoplay: 1,
      playsinline: 1,
      cc_load_policy: nativeCaptions ? 1 : 0,
      cc_lang_pref: "hu",
      start: Math.max(0, Math.floor(startSeconds)),
      rel: 0,
      modestbranding: 1
    },
    events: {
      onReady: () => {
        startPlaybackPolling();
      },
      onStateChange: (ev) => {
        const playing = ev.data === YT.PlayerState.PLAYING;
        els.btnPlayPause.textContent = playing ? "⏸ Szünet" : "▶ Lejátszás";
      }
    }
  });
}

function startPlaybackPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (!state.ytPlayer || typeof state.ytPlayer.getCurrentTime !== "function") return;
    const current = Number(state.ytPlayer.getCurrentTime() || 0);
    const duration = Number(state.ytPlayer.getDuration() || 0);

    if (!state.isSeeking && duration > 0) {
      els.seekBar.max = duration;
      els.seekBar.value = current;
      els.timeCurrent.textContent = formatTime(current);
      els.timeDuration.textContent = formatTime(duration);
    }

    updateActiveSubtitle(current);
  }, 160);
}

function updateActiveSubtitle(currentSec) {
  if (!state.cues.length) return;
  const idx = state.cues.findIndex((c) => currentSec >= c.start && currentSec <= c.end);
  if (idx === state.activeCueIndex) return;

  const prev = state.activeCueIndex;
  state.activeCueIndex = idx;
  refreshSubtitleDisplay();

  if (prev >= 0) {
    const prevEl = els.transcriptList.children[prev];
    if (prevEl) prevEl.classList.remove("active");
  }
  if (idx >= 0) {
    const curEl = els.transcriptList.children[idx];
    if (curEl) {
      curEl.classList.add("active");
      if (Date.now() > state.userScrollingTranscriptUntil) {
        curEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  }
}

function refreshSubtitleDisplay() {
  const cue = state.cues[state.activeCueIndex];
  if (!cue) {
    if (state.cues.length === 0) {
      els.subHu.textContent = "Itt jelenik meg a magyar felirat.";
      els.subHu.classList.add("placeholder");
      els.subOrig.hidden = true;
    } else {
      els.subHu.textContent = "";
      els.subOrig.textContent = "";
    }
    return;
  }

  els.subHu.classList.remove("placeholder");
  els.subHu.textContent = cue.translated || cue.original;
  els.subOrig.textContent = cue.original;
  els.subOrig.hidden = !state.settings.bilingual;
}

// ---------------- Fetch Captions & Progressive Translation ----------------

async function loadVideoFromInput(rawInput, preferredLang = "", allowSupadata = false) {
  const videoId = extractVideoId(rawInput);
  if (!videoId) {
    setStatus("Nem érvényes YouTube-link.", { error: true });
    els.playerCard.hidden = false;
    return;
  }

  state.loadEpoch++;
  showFreeOptions(videoId);
  setNativeCaptionLayout(false);

  // Cancel any ongoing translation
  if (state.translationAbortController) {
    state.translationAbortController.abort();
  }
  const abortController = new AbortController();
  state.translationAbortController = abortController;

  const isNewVideo = state.videoId !== videoId;
  state.chromeSession?.destroy();
  state.chromeSession = null;
  state.chromeAttempted = false;
  state.deepLDisabled = false;
  state.sourceLanguage = "";
  els.btnCaptionFallback.hidden = true;
  els.btnEnableChrome.hidden = true;
  state.videoId = videoId;
  state.cues = [];
  state.activeCueIndex = -1;
  if (isNewVideo) {
    // Hide the previous video's title and track list until the new captions arrive.
    state.tracks = [];
    els.videoMeta.hidden = true;
    els.trackSelect.hidden = true;
  }

  els.heroSection.classList.add("compact");
  els.playerCard.hidden = false;
  els.transcriptCard.hidden = true;
  els.transcriptList.innerHTML = "";
  els.subHu.textContent = "Felirat letöltése és fordítása...";
  els.subHu.classList.add("placeholder");
  els.subOrig.hidden = true;

  mountOrLoadPlayer(videoId);
  setStatus("Feliratsáv letöltése a YouTube-ról...", { loading: true });

  try {
    const capResp = await fetch("/api/captions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        videoId,
        lang: preferredLang || undefined,
        useSupadata: allowSupadata,
        supadataKey: allowSupadata ? state.settings.supadataKey || undefined : undefined
      })
    });

    const capData = await readJsonResponse(capResp);
    abortController.signal.throwIfAborted();
    if (!capResp.ok) {
      if (capData.details) console.warn("[captions] részletek:", capData.details);
      const capErr = new Error(capData.error || "Nem sikerült letölteni a feliratot.");
      capErr.reason = capData.reason;
      els.btnCaptionFallback.hidden = allowSupadata || !(capData.canUseFallback || state.settings.supadataKey);
      throw capErr;
    }

    state.sourceLanguage = capData.selectedTrack?.langCode || "";
    state.sourceLangName = capData.selectedTrack?.langName || "";
    state.title = capData.title || `YouTube videó (${videoId})`;
    state.tracks = capData.tracks || [];
    state.cues = (capData.cues || []).map((c) => ({
      start: c.start,
      end: c.end,
      original: c.text,
      translated: capData.alreadyHungarian ? c.text : null
    }));

    els.videoMeta.hidden = false;
    els.videoTitle.textContent = state.title;
    renderTrackSelector(capData.selectedTrack?.langCode);
    addToHistory(videoId, state.title);
    renderTranscriptList();

    if (capData.alreadyHungarian) {
      setStatus(`Kész — eredeti magyar felirat betöltve (${state.cues.length} sor).`);
      refreshSubtitleDisplay();
      return;
    }

    const sourceLabel = capData.selectedTrack?.langName || "";
    try {
      await translateAllProgressive(
        abortController.signal,
        capData.source === "supadata" ? `${sourceLabel} (Supadata)` : sourceLabel
      );
    } catch (err) {
      if (err.name === "AbortError") return;
      // The captions are loaded: keep showing them in the original language.
      setStatus(`Fordítási hiba: ${err.message || "ismeretlen hiba"}. Az eredeti felirat látszik (↻ Újra).`, {
        error: true
      });
      refreshSubtitleDisplay();
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    els.captionNotice.textContent = "Az automatikus letöltés nem sikerült. Az alábbi két ingyenes lehetőséggel folytathatod.";
    setStatus("A felirat letöltése nem sikerült. Válassz az ingyenes lehetőségek közül.", { error: true });
    els.subHu.textContent =
      err.reason === "youtube_blocked"
        ? "A YouTube most nem engedte letölteni a feliratot. Lent találsz ingyenes megoldást."
        : "Ehhez a videóhoz nem érkezett felirat.";
    els.subHu.classList.add("placeholder");
  }
}

function showFreeOptions(videoId) {
  els.freeOptions.hidden = false;
  els.openYouTube.href = "https://www.youtube.com/watch?v=" + videoId;
  els.captionNotice.textContent = "Ezekhez a lehetőségekhez nem kell API-kulcs, kredit vagy számítógép.";
}

function setNativeCaptionLayout(native) {
  els.subtitleStage.hidden = native;
  for (const control of [els.btnBilingual, els.btnFontDown, els.btnFontUp]) control.disabled = native;
}

function useNativeCaptions() {
  if (!state.videoId) return;
  state.translationAbortController?.abort();
  state.loadEpoch++;
  state.chromeSession?.destroy();
  state.chromeSession = null;
  const startSeconds = Number(state.ytPlayer?.getCurrentTime?.() || 0);
  state.cues = [];
  state.activeCueIndex = -1;
  els.transcriptCard.hidden = true;
  els.btnCaptionFallback.hidden = true;
  els.btnEnableChrome.hidden = true;
  setNativeCaptionLayout(true);
  mountOrLoadPlayer(state.videoId, { nativeCaptions: true, startSeconds });
  setStatus("YouTube-feliratok: a videó fogaskerekénél válaszd a Feliratok → Automatikus fordítás → Magyar lehetőséget, ha elérhető.");
  els.captionNotice.textContent = "Ebben a módban a felirat a videón jelenik meg. Magyar fordítást a YouTube feliratmenüjében választhatsz.";
}

async function importSubtitleText(text, language = "", filename = "Beillesztett felirat") {
  // Validate before changing playback or cancelling an existing translation.
  const videoId = extractVideoId(els.urlInput.value || state.videoId);
  if (!videoId) throw new Error("Előbb illeszd be a videó YouTube-linkjét.");
  const cues = parseTimedSubtitles(text);
  const needsPlayerLoad = state.videoId !== videoId || !state.ytPlayer || state.nativeCaptionMode;
  const startSeconds = state.videoId === videoId ? Number(state.ytPlayer?.getCurrentTime?.() || 0) : 0;
  state.translationAbortController?.abort();
  state.chromeSession?.destroy();
  state.chromeSession = null;
  state.chromeAttempted = false;
  state.deepLDisabled = false;
  state.loadEpoch++;
  const controller = new AbortController();
  state.translationAbortController = controller;
  const sameVideo = state.videoId === videoId;
  state.videoId = videoId;
  state.title = sameVideo && state.title ? state.title : "YouTube videó (" + videoId + ")";
  state.sourceLanguage = language;
  state.sourceLangName = filename;
  state.tracks = [];
  state.activeCueIndex = -1;
  state.cues = cues.map(cue => ({ start: cue.start, end: cue.end, original: cue.text,
    translated: language === "hu" ? cue.text : null }));
  els.heroSection.classList.add("compact");
  els.playerCard.hidden = false;
  els.videoMeta.hidden = false;
  els.videoTitle.textContent = state.title;
  els.trackSelect.hidden = true;
  els.btnCaptionFallback.hidden = true;
  els.btnEnableChrome.hidden = true;
  showFreeOptions(videoId);
  setNativeCaptionLayout(false);
  if (needsPlayerLoad) mountOrLoadPlayer(videoId, { startSeconds });
  addToHistory(videoId, state.title);
  renderTranscriptList();
  updateActiveSubtitle(startSeconds);
  els.captionNotice.textContent = cues.length + " feliratsor betöltve. A feliratletöltő szolgáltatást nem használjuk.";
  if (language === "hu") {
    setStatus("Kész — magyar felirat betöltve (" + cues.length + " sor).");
    refreshSubtitleDisplay();
    return;
  }
  try { await translateAllProgressive(controller.signal, filename); }
  catch (error) {
    if (error.name !== "AbortError") setStatus("A felirat betöltve, de a fordítás nem sikerült: " + error.message, { error: true });
  }
}


function renderTrackSelector(selectedLangCode) {
  if (!state.tracks || state.tracks.length <= 1) {
    els.trackSelect.hidden = true;
    return;
  }
  els.trackSelect.hidden = false;
  els.trackSelect.innerHTML = "";
  for (const t of state.tracks) {
    const opt = document.createElement("option");
    opt.value = t.langCode;
    opt.textContent = t.isAuto ? `${t.langName} (auto)` : t.langName;
    if (t.langCode === selectedLangCode) opt.selected = true;
    els.trackSelect.appendChild(opt);
  }
}

function renderTranscriptList() {
  els.transcriptCard.hidden = state.cues.length === 0;
  els.cueCounter.textContent = `${state.cues.length} sor`;
  els.transcriptList.innerHTML = "";

  const frag = document.createDocumentFragment();
  state.cues.forEach((cue, idx) => {
    const row = document.createElement("div");
    row.className = "cue-item";
    row.dataset.index = String(idx);
    row.innerHTML = `
      <div class="cue-time">${formatTime(cue.start)}</div>
      <div class="cue-texts">
        <div class="cue-hu">${escapeHtml(cue.translated || "… fordítás folyamatban")}</div>
        <div class="cue-orig">${escapeHtml(cue.original)}</div>
      </div>
    `;
    row.addEventListener("click", () => {
      if (state.ytPlayer && typeof state.ytPlayer.seekTo === "function") {
        state.ytPlayer.seekTo(cue.start, true);
        if (typeof state.ytPlayer.playVideo === "function") {
          state.ytPlayer.playVideo();
        }
      }
    });
    frag.appendChild(row);
  });
  els.transcriptList.appendChild(frag);
}

function updateTranscriptRange(startIdx, endIdx) {
  for (let i = startIdx; i < endIdx; i++) {
    const row = els.transcriptList.children[i];
    if (!row) continue;
    const huEl = row.querySelector(".cue-hu");
    if (huEl && state.cues[i]?.translated) {
      huEl.textContent = state.cues[i].translated;
    }
  }
}

async function translateAllProgressive(signal, sourceLangName) {
  const total = state.cues.length;
  const activeEngine = "browser_free";
  const batchSize = 20;

  const enginesUsed = new Set();
  let failedTotal = 0;
  let lastError = "";
  setStatus(
    `Forrás: ${sourceLangName || "eredeti"}, fordítás (${engineLabel(activeEngine)})...`,
    { loading: true }
  );

  for (let i = 0; i < total; i += batchSize) {
    if (signal.aborted) return;
    const end = Math.min(i + batchSize, total);
    const slice = state.cues.slice(i, end);

    let data;
    try {
      data = await translateBatch(
        slice.map((c) => c.original),
        activeEngine,
        signal
      );
    } catch (err) {
      if (err.name === "AbortError") throw err;
      // Keep the original text for this batch and carry on with the rest.
      lastError = err.message || "ismeretlen hiba";
      data = { engine: activeEngine, translations: [], failed: slice.length };
    }

    for (const engine of data.engines || [data.engine]) enginesUsed.add(engine);
    failedTotal += Number(data.failed) || 0;

    const translatedArr = Array.isArray(data.translations) ? data.translations : [];
    for (let j = 0; j < slice.length; j++) {
      state.cues[i + j].translated = translatedArr[j] || slice[j].original;
    }

    updateTranscriptRange(i, end);
    refreshSubtitleDisplay();

    const usedLabel = engineLabel(data.engine || activeEngine);
    if (end < total) {
      setStatus(`Fordítás (${usedLabel}): ${end} / ${total} sor kész...`, { loading: true });
    } else if (lastError && failedTotal >= total) {
      throw new Error(lastError);
    } else {
      const suffix = enginesUsed.size > 1 ? " · több fordító" : "";
      const done = failedTotal
        ? `${total - failedTotal} / ${total} sor lefordítva, ${failedTotal} eredeti nyelven maradt (↻ Újra).`
        : `${total} sor lefordítva.`;
      setStatus(`Kész (${usedLabel}${suffix}): ${done}`, { error: failedTotal > 0 });
    }
  }
}

// ---------------- Fullscreen ----------------

async function enterFullscreen() {
  try {
    if (els.playerStage.requestFullscreen) {
      await els.playerStage.requestFullscreen();
    } else if (els.playerStage.webkitRequestFullscreen) {
      els.playerStage.webkitRequestFullscreen();
    }
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock("landscape").catch(() => {});
    }
  } catch {
    // Some browsers disallow orientation lock without fullscreen
  }
}

async function exitFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  } catch {}
}

document.addEventListener("fullscreenchange", () => {
  const isFs = Boolean(document.fullscreenElement);
  els.btnExitFs.hidden = !isFs;
});

// ---------------- PWA Install & Share Target ----------------

function setupPwa() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  if (isStandalone) {
    els.badgeInstalled.hidden = false;
    els.btnInstall.hidden = true;
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    if (!isStandalone) {
      els.btnInstall.hidden = false;
    }
  });

  window.addEventListener("appinstalled", () => {
    state.deferredInstallPrompt = null;
    els.btnInstall.hidden = true;
    els.badgeInstalled.hidden = false;
  });

  els.btnInstall.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    els.btnInstall.hidden = true;
  });

  // Check if opened via YouTube "Megosztás" (Web Share Target) or ?v= param
  const params = new URLSearchParams(window.location.search);
  const sharedCandidate =
    params.get("url") || params.get("text") || params.get("v") || "";
  if (sharedCandidate) {
    const id = extractVideoId(sharedCandidate);
    if (id) {
      const cleanUrl = `https://www.youtube.com/watch?v=${id}`;
      els.urlInput.value = cleanUrl;
      // Remove query params from address bar
      window.history.replaceState({}, document.title, "/");
      loadVideoFromInput(cleanUrl);
    }
  }
}

// ---------------- Event Listeners ----------------

function bindEvents() {
  els.btnNativeCaptions.addEventListener("click", useNativeCaptions);
  els.btnImportText.addEventListener("click", async () => {
    try { await importSubtitleText(els.subtitleText.value, els.importLanguage.value); }
    catch (error) { setStatus(error.message, { error: true }); }
  });
  els.subtitleFile.addEventListener("change", async () => {
    const file = els.subtitleFile.files?.[0];
    if (!file) return;
    const epoch = state.loadEpoch;
    const selectedVideo = els.urlInput.value;
    const language = els.importLanguage.value;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("A feliratfájl legfeljebb 2 MB lehet.");
      const text = await file.text();
      if (epoch !== state.loadEpoch || selectedVideo !== els.urlInput.value) return;
      await importSubtitleText(text, language, file.name);
    } catch (error) { setStatus(error.message, { error: true }); }
    finally { els.subtitleFile.value = ""; }
  });
  els.btnLoad.addEventListener("click", () => loadVideoFromInput(els.urlInput.value));
  els.urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadVideoFromInput(els.urlInput.value);
    }
  });

  els.btnPaste.addEventListener("click", async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) {
        els.urlInput.value = clip.trim();
        if (extractVideoId(clip)) {
          loadVideoFromInput(clip);
        }
      }
    } catch {
      els.urlInput.focus();
    }
  });

  els.trackSelect.addEventListener("change", () => {
    if (state.videoId) {
      loadVideoFromInput(state.videoId, els.trackSelect.value);
    }
  });

  els.btnPlayPause.addEventListener("click", () => {
    if (!state.ytPlayer || typeof state.ytPlayer.getPlayerState !== "function") return;
    if (state.ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
      state.ytPlayer.pauseVideo();
    } else {
      state.ytPlayer.playVideo();
    }
  });

  els.btnBack5.addEventListener("click", () => {
    if (!state.ytPlayer) return;
    const t = Math.max(0, Number(state.ytPlayer.getCurrentTime() || 0) - 5);
    state.ytPlayer.seekTo(t, true);
  });

  els.btnFwd5.addEventListener("click", () => {
    if (!state.ytPlayer) return;
    const t = Number(state.ytPlayer.getCurrentTime() || 0) + 5;
    state.ytPlayer.seekTo(t, true);
  });

  els.seekBar.addEventListener("input", () => {
    state.isSeeking = true;
    els.timeCurrent.textContent = formatTime(els.seekBar.value);
  });

  els.seekBar.addEventListener("change", () => {
    state.isSeeking = false;
    if (state.ytPlayer && typeof state.ytPlayer.seekTo === "function") {
      state.ytPlayer.seekTo(Number(els.seekBar.value), true);
    }
  });

  els.btnFullscreen.addEventListener("click", enterFullscreen);
  els.btnExitFs.addEventListener("click", exitFullscreen);

  els.btnBilingual.addEventListener("click", () => {
    state.settings.bilingual = !state.settings.bilingual;
    saveSettings();
    applySubtitleStyle();
    refreshSubtitleDisplay();
  });

  els.btnFontDown.addEventListener("click", () => {
    state.settings.fontSize = Math.max(13, state.settings.fontSize - 2);
    saveSettings();
    applySubtitleStyle();
  });

  els.btnFontUp.addEventListener("click", () => {
    state.settings.fontSize = Math.min(30, state.settings.fontSize + 2);
    saveSettings();
    applySubtitleStyle();
  });

  els.btnRetranslate.addEventListener("click", () => {
    if (state.cues.length) restartTranslation();
    else if (state.videoId) loadVideoFromInput(state.videoId, els.trackSelect.value || "");
  });
  els.btnEnableChrome.addEventListener("click", () => restartTranslation(true));
  els.btnCaptionFallback.addEventListener("click", () => {
    if (state.videoId) loadVideoFromInput(state.videoId, els.trackSelect.value || "", true);
  });

  els.transcriptList.addEventListener("touchstart", () => {
    state.userScrollingTranscriptUntil = Date.now() + 6000;
  }, { passive: true });
  els.transcriptList.addEventListener("wheel", () => {
    state.userScrollingTranscriptUntil = Date.now() + 6000;
  }, { passive: true });

  els.btnClearHistory.addEventListener("click", () => {
    localStorage.removeItem(STORAGE_HISTORY);
    renderHistory();
  });

  // Settings Modal
  els.btnSettings.addEventListener("click", () => {
    els.inputDeepLKey.value = state.settings.deeplKey;
    els.inputDeepLPlan.value = state.settings.deeplPlan;
    els.inputSupadataKey.value = state.settings.supadataKey;
    els.settingsModal.hidden = false;
  });

  els.btnCloseSettings.addEventListener("click", () => {
    els.settingsModal.hidden = true;
  });

  els.settingsModal.addEventListener("click", (e) => {
    if (e.target === els.settingsModal) els.settingsModal.hidden = true;
  });

  els.btnSaveSettings.addEventListener("click", () => {
    state.settings.engine = "browser_free";
    state.settings.deeplKey = els.inputDeepLKey.value.trim();
    state.settings.deeplPlan = els.inputDeepLPlan.value;
    state.settings.supadataKey = els.inputSupadataKey.value.trim();
    saveSettings();
    els.settingsModal.hidden = true;

    if (state.cues.length) restartTranslation();
  });
}

// Init
applySubtitleStyle();
renderHistory();
bindEvents();
setupPwa();


