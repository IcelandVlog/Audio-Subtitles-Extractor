// Shared subtitle "cue" model used by every converter tool.
// A cue is: { start: number(ms), end: number(ms), text: string }
// text may contain "\n" for multi-line captions and simple <b>/<i>/<u> tags.

function pad(n, len = 2) {
  return String(n).padStart(len, "0");
}

export function msToSrtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRem = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msRem, 3)}`;
}

export function msToVttTime(ms) {
  return msToSrtTime(ms).replace(",", ".");
}

// Parses "HH:MM:SS,mmm" / "HH:MM:SS.mmm" / "MM:SS.mmm" / "H:MM:SS.cc" (ASS centiseconds)
export function timeStrToMs(str, { centiseconds = false } = {}) {
  const clean = str.trim().replace(",", ".");
  const parts = clean.split(":");
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) {
    [h, m, s] = parts;
  } else if (parts.length === 2) {
    [m, s] = parts;
  } else {
    s = parts[0];
  }
  const [secWhole, fracRaw = "0"] = String(s).split(".");
  const frac = centiseconds
    ? Number(fracRaw.padEnd(2, "0").slice(0, 2)) * 10
    : Number(fracRaw.padEnd(3, "0").slice(0, 3));
  return (
    Number(h) * 3600000 +
    Number(m) * 60000 +
    Number(secWhole) * 1000 +
    frac
  );
}

// ---------- SRT ----------

const SRT_TIME_RE =
  /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})/;

export function parseSrt(text) {
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "" || l === "");
    let idx = 0;
    // optional numeric index line
    if (/^\d+$/.test(lines[0]?.trim())) idx = 1;
    const timeLine = lines[idx];
    if (!timeLine) continue;
    const m = timeLine.match(SRT_TIME_RE);
    if (!m) continue;
    const start = timeStrToMs(m[1]);
    const end = timeStrToMs(m[2]);
    const text = lines.slice(idx + 1).join("\n").trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

export function toSrtText(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${msToSrtTime(c.start)} --> ${msToSrtTime(c.end)}\n${c.text}`)
    .join("\n\n")
    .concat("\n");
}

// ---------- WebVTT ----------

const VTT_TIME_RE =
  /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{2}:\d{2}[.,]\d{1,3})/;

export function parseVtt(text) {
  const body = text.replace(/\r/g, "").replace(/^WEBVTT[^\n]*\n/, "");
  const blocks = body.split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith("NOTE") || trimmed.startsWith("STYLE") || trimmed.startsWith("REGION")) {
      continue;
    }
    const lines = trimmed.split("\n");
    let idx = 0;
    if (!VTT_TIME_RE.test(lines[0])) idx = 1; // skip cue identifier line
    const timeLine = lines[idx];
    if (!timeLine) continue;
    const m = timeLine.match(VTT_TIME_RE);
    if (!m) continue;
    const start = timeStrToMs(m[1]);
    const end = timeStrToMs(m[2]);
    const text = lines
      .slice(idx + 1)
      .join("\n")
      .trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

export function toVttText(cues) {
  const body = cues
    .map((c) => `${msToVttTime(c.start)} --> ${msToVttTime(c.end)}\n${c.text}`)
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

// ---------- SBV (YouTube) ----------

const SBV_TIME_RE = /(\d+:\d{2}:\d{2}\.\d{3}),(\d+:\d{2}:\d{2}\.\d{3})/;

export function parseSbv(text) {
  const blocks = text.replace(/\r/g, "").trim().split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const m = lines[0]?.match(SBV_TIME_RE);
    if (!m) continue;
    const start = timeStrToMs(m[1]);
    const end = timeStrToMs(m[2]);
    const text = lines.slice(1).join("\n").trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

// ---------- ASS / SSA ----------

function assTagsToText(raw) {
  return raw
    .replace(/\{[^}]*\}/g, "") // override tags {\...}
    .replace(/\\N/gi, "\n")
    .replace(/\\n/gi, "\n")
    .replace(/\\h/gi, " ")
    .trim();
}

export function parseAss(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  let inEvents = false;
  let fields = [];
  const cues = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[Events\]/i.test(trimmed)) {
      inEvents = true;
      continue;
    }
    if (/^\[/.test(trimmed) && inEvents) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(trimmed)) {
      fields = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((f) => f.trim().toLowerCase());
      continue;
    }
    if (/^Dialogue:/i.test(trimmed)) {
      const rest = trimmed.slice(trimmed.indexOf(":") + 1).trim();
      const parts = rest.split(",");
      const textStartIdx = fields.length || 9;
      const startI = fields.indexOf("start");
      const endI = fields.indexOf("end");
      const textI = fields.indexOf("text");
      const startField = parts[startI >= 0 ? startI : 1];
      const endField = parts[endI >= 0 ? endI : 2];
      const textField = parts
        .slice(textI >= 0 ? textI : textStartIdx - 1)
        .join(",");
      if (!startField || !endField) continue;
      const start = timeStrToMs(startField, { centiseconds: true });
      const end = timeStrToMs(endField, { centiseconds: true });
      const cleanText = assTagsToText(textField);
      if (cleanText) cues.push({ start, end, text: cleanText });
    }
  }
  return cues;
}

// ---------- Auto-detect ----------

export function detectFormat(filename, text) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  if (ext === "srt") return "srt";
  if (ext === "vtt") return "vtt";
  if (ext === "sbv") return "sbv";
  if (ext === "ass" || ext === "ssa") return "ass";
  const head = text.slice(0, 500);
  if (/^WEBVTT/.test(head.trim())) return "vtt";
  if (/\[Script Info\]|\[Events\]/i.test(head)) return "ass";
  if (/\d+:\d{2}:\d{2}\.\d{3},\d+:\d{2}:\d{2}\.\d{3}/.test(head)) return "sbv";
  if (/\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/.test(head)) return "srt";
  return "srt";
}

export function parseAny(filename, text) {
  const format = detectFormat(filename, text);
  switch (format) {
    case "vtt":
      return { format, cues: parseVtt(text) };
    case "ass":
      return { format, cues: parseAss(text) };
    case "sbv":
      return { format, cues: parseSbv(text) };
    default:
      return { format: "srt", cues: parseSrt(text) };
  }
}
