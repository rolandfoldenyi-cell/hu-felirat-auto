// Keep the app's timed captions in the same viewport as the YouTube iframe.
export function createPlayerLayout({ stage, card, exitButton, nativePort = null }) {
  const landscape = window.matchMedia("(orientation: landscape) and (max-height: 600px)");
  let manual = false;
  let dismissed = false;
  let expanded = false;
  let browserFullscreen = false;
  const touchDevice = Boolean(nativePort || navigator.maxTouchPoints > 0);

  function sync() {
    if (!landscape.matches) dismissed = false;
    const next = !card.hidden && (manual || (touchDevice && landscape.matches && !dismissed));
    stage.classList.toggle("wide-player", next);
    document.body.classList.toggle("wide-player-open", next);
    exitButton.hidden = !next;
    // Also notify when manual mode changes while landscape mode is already active.
    if (nativePort) nativePort.postMessage(JSON.stringify({ type: "playerLayout", expanded: next, lockLandscape: next && manual }));
    expanded = next;
  }

  async function enter() {
    manual = true;
    dismissed = false;
    sync();
    // Android expands the original WebView, preserving the captions and player.
    if (nativePort) return;
    try {
      if (stage.requestFullscreen) await stage.requestFullscreen();
      else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        await screen.orientation?.lock?.("landscape").catch(() => {});
      }
    } catch { /* The viewport layout also works when Fullscreen API is denied. */ }
  }

  async function exit() {
    manual = false;
    dismissed = true;
    sync();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
      screen.orientation?.unlock?.();
    } catch {}
  }

  function fullscreenChanged() {
    const current = document.fullscreenElement || document.webkitFullscreenElement;
    if (current === stage) { browserFullscreen = true; manual = true; sync(); }
    else if (browserFullscreen) { browserFullscreen = false; exit(); }
  }
  landscape.addEventListener("change", sync);
  new MutationObserver(sync).observe(card, { attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("hu-enter-player", enter);
  window.addEventListener("hu-exit-player", exit);
  document.addEventListener("fullscreenchange", fullscreenChanged);
  document.addEventListener("webkitfullscreenchange", fullscreenChanged);
  document.addEventListener("keydown", event => { if (event.key === "Escape" && expanded) exit(); });
  sync();
  return { enter, exit };
}
