// HU Felirat Auto PWA — Automatic YouTube caption fetch + progressive Hungarian translation

const STORAGE_SETTINGS = "hufelirat_auto_settings_v2";
const STORAGE_HISTORY = "hufelirat_auto_history_v2";

const state = {
  settings: loadSettings(),
  videoId: null,
  title: "",
  tracks: [],
  cues: [], // { start, end, original, translated }
  activeCueIndex: -1,
  ytPlayer: null,
  ytApiReady: false,
  pendingVideoId: null,
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
  inputApiKey: document.getElementById("inputApiKey"),
  inputModel: document.getElementById("inputModel"),
  inputSupadataKey: document.getElementById("inputSupadataKey")
};

// ---------------- Settings & History ----------------

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_SETTINGS) || "{}");
    return {
      engine: raw.engine || "google_free",
      apiKey: raw.apiKey || "",
      model: raw.model || "",
      supadataKey: raw.supadataKey || "",
      bilingual: Boolean(raw.bilingual),
      fontSize: Number(raw.fontSize) || 18
    };
  } catch {
    return {
      engine: "google_free",
      apiKey: "",
      model: "",
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
  if (engine === "gemini") return "Gemini AI";
  if (engine === "openai") return "OpenAI GPT";
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

async function translateBatch(texts, activeEngine, signal) {
  if (activeEngine === "google_free") {
    try {
      return await translateGoogleDirect(texts, signal);
    } catch (err) {
      if (err.name === "AbortError") throw err;
      console.warn("[translate] közvetlen Google-hívás sikertelen, szerveres tartalék:", err);
    }
  }
  const resp = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      texts,
      engine: activeEngine,
      apiKey: state.settings.apiKey,
      model: state.settings.model
    })
  });
  const data = await readJsonResponse(resp);
  if (!resp.ok) {
    throw new Error(data.error || "Fordítási hiba.");
  }
  return data;
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
    mountOrLoadPlayer(state.pendingVideoId);
    state.pendingVideoId = null;
  }
};

function mountOrLoadPlayer(videoId) {
  if (!state.ytApiReady || typeof YT === "undefined" || !YT.Player) {
    state.pendingVideoId = videoId;
    return;
  }

  if (state.ytPlayer && typeof state.ytPlayer.loadVideoById === "function") {
    state.ytPlayer.loadVideoById(videoId);
    return;
  }

  state.ytPlayer = new YT.Player("ytPlayerMount", {
    videoId,
    playerVars: {
      autoplay: 1,
      playsinline: 1,
      cc_load_policy: 0,
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

async function loadVideoFromInput(rawInput, preferredLang = "") {
  const videoId = extractVideoId(rawInput);
  if (!videoId) {
    setStatus("Nem érvényes YouTube-link.", { error: true });
    els.playerCard.hidden = false;
    return;
  }

  // Cancel any ongoing translation
  if (state.translationAbortController) {
    state.translationAbortController.abort();
  }
  const abortController = new AbortController();
  state.translationAbortController = abortController;

  const isNewVideo = state.videoId !== videoId;
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
        supadataKey: state.settings.supadataKey || undefined
      })
    });

    const capData = await readJsonResponse(capResp);
    if (!capResp.ok) {
      if (capData.details) console.warn("[captions] részletek:", capData.details);
      const capErr = new Error(capData.error || "Nem sikerült letölteni a feliratot.");
      capErr.reason = capData.reason;
      throw capErr;
    }

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
    setStatus(err.message || "Hiba történt a felirat betöltése közben.", { error: true });
    els.subHu.textContent =
      err.reason === "youtube_blocked"
        ? "A YouTube nem adta ki ennek a videónak a feliratát a szervernek (részletek lent)."
        : "Ehhez a videóhoz nem érkezett felirat.";
    els.subHu.classList.add("placeholder");
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
  const engine = state.settings.engine;
  const hasKey = Boolean(state.settings.apiKey);
  const activeEngine = (engine === "gemini" || engine === "openai") && !hasKey ? "google_free" : engine;
  const batchSize = activeEngine === "google_free" ? 20 : 24;

  let warningShown = "";
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

    if (data.fallbackWarning && !warningShown) {
      warningShown = data.fallbackWarning;
    }
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
      const suffix = warningShown ? " (AI hiba miatt Google tartalék)" : "";
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
    if (state.videoId) {
      loadVideoFromInput(state.videoId, els.trackSelect.value || "");
    }
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
    const radio = document.querySelector(`input[name="engine"][value="${state.settings.engine}"]`);
    if (radio) radio.checked = true;
    els.inputApiKey.value = state.settings.apiKey;
    els.inputModel.value = state.settings.model;
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
    const selected = document.querySelector('input[name="engine"]:checked')?.value || "google_free";
    state.settings.engine = selected;
    state.settings.apiKey = els.inputApiKey.value.trim();
    state.settings.model = els.inputModel.value.trim();
    state.settings.supadataKey = els.inputSupadataKey.value.trim();
    saveSettings();
    els.settingsModal.hidden = true;

    if (state.videoId) {
      loadVideoFromInput(state.videoId, els.trackSelect.value || "");
    }
  });
}

// Init
applySubtitleStyle();
renderHistory();
bindEvents();
setupPwa();
