const MAX_CUES = 25000;

function seconds(time) {
  const match = time.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) return NaN;
  const [, hours = "0", minutes, secs, fraction] = match;
  if (Number(minutes) >= 60 || Number(secs) >= 60) return NaN;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(secs) +
    Number(fraction.padEnd(3, "0")) / 1000;
}

function plainText(text) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name) => {
      if (name[0] !== "#") return entities[name.toLowerCase()] || entity;
      const hex = name[1].toLowerCase() === "x";
      const point = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : "";
    })
    .replace(/\s+/g, " ").trim();
}

// SRT and WebVTT are read locally. No caption provider is called for imports.
export function parseTimedSubtitles(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Válassz feliratfájlt, vagy illeszd be az SRT/VTT szövegét.");
  }
  if (input.length > 2 * 1024 * 1024) throw new Error("A felirat legfeljebb 2 MB lehet.");
  const blocks = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n[\t ]*\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
    const at = lines.findIndex(line => line.includes("-->"));
    if (at < 0) continue;
    const timing = lines[at].trim().match(/^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/);
    if (!timing) continue;
    const start = seconds(timing[1]);
    const end = seconds(timing[2]);
    const text = plainText(lines.slice(at + 1).join(" "));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
    cues.push({ start, end, text });
    if (cues.length > MAX_CUES) throw new Error("A felirat túl sok sort tartalmaz.");
  }
  if (!cues.length) throw new Error("Nem találtam időzített SRT/VTT feliratot. A fájlnak időbélyegeket is tartalmaznia kell.");
  return cues.sort((a, b) => a.start - b.start);
}
