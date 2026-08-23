// Shared subtitle parsing / serialization / time helpers used by every tool page.
// A "cue" is normalized to: { index, start, end, text } where start/end are in ms.

export function msToSrtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRem = ms % 1000;
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msRem, 3)}`;
}

export function msToVttTime(ms) {
  return msToSrtTime(ms).replace(",", ".");
}

export function timeToMs(str) {
  // Accepts "HH:MM:SS,mmm" / "HH:MM:SS.mmm" / "H:MM:SS.mmm" / "MM:SS.mmm"
  const clean = str.trim().replace(",", ".");
  const parts = clean.split(":");
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) {
    h = Number(parts[0]);
    m = Number(parts[1]);
    s = Number(parts[2]);
  } else if (parts.length === 2) {
    m = Number(parts[0]);
    s = Number(parts[1]);
  } else {
    s = Number(parts[0]);
  }
  return Math.round(h * 3600000 + m * 60000 + s * 1000);
}

function detectFormat(filenameOrText, text) {
  const name = (filenameOrText || "").toLowerCase();
  if (name.endsWith(".vtt")) return "vtt";
  if (name.endsWith(".ass") || name.endsWith(".ssa")) return "ass";
  if (name.endsWith(".sbv")) return "sbv";
  if (name.endsWith(".srt")) return "srt";
  const t = text.trim();
  if (t.startsWith("WEBVTT")) return "vtt";
  if (/^\[Script Info\]/m.test(t)) return "ass";
  if (/^\d+\n\d{2}:\d{2}:\d{2}[,.]\d{3}/m.test(t)) return "srt";
  if (/^\d{1,2}:\d{2}:\d{2}\.\d{3},\d{1,2}:\d{2}:\d{2}\.\d{3}/m.test(t)) return "sbv";
  return "srt";
}

function stripTags(text) {
  // Strip HTML-ish tags (<b>, <i>, <font color="">, {\an8}, {\pos()}, etc.)
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\{[^}]*\}/g, "")
    .trim();
}

export function parseSrt(text) {
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) continue;
    let li = 0;
    // optional numeric index line
    if (/^\d+$/.test(lines[0].trim())) li = 1;
    const timeLine = lines[li];
    const m = timeLine && timeLine.match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!m) continue;
    const start = timeToMs(m[1]);
    const end = timeToMs(m[2]);
    const textLines = lines.slice(li + 1);
    if (textLines.length === 0) continue;
    cues.push({ index: cues.length + 1, start, end, text: textLines.join("\n") });
  }
  return cues;
}

export function parseVtt(text) {
  const body = text.replace(/\r/g, "").replace(/^WEBVTT[^\n]*\n/, "");
  const blocks = body.split(/\n\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    let li = 0;
    if (!lines[0].includes("-->")) li = 1; // skip cue identifier line
    const timeLine = lines[li];
    const m = timeLine && timeLine.match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
    if (!m) continue;
    const start = timeToMs(m[1]);
    const end = timeToMs(m[2]);
    const textLines = lines.slice(li + 1);
    if (textLines.length === 0) continue;
    cues.push({ index: cues.length + 1, start, end, text: textLines.join("\n") });
  }
  return cues;
}

export function parseSbv(text) {
  const blocks = text.replace(/\r/g, "").trim().split(/\n\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) continue;
    const m = lines[0].match(/([\d:.]+),([\d:.]+)/);
    if (!m) continue;
    cues.push({
      index: cues.length + 1,
      start: timeToMs(m[1]),
      end: timeToMs(m[2]),
      text: lines.slice(1).join("\n"),
    });
  }
  return cues;
}

export function parseAss(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  let format = [];
  const cues = [];
  for (const line of lines) {
    if (/^Format:/i.test(line) && /Start/i.test(line)) {
      format = line.replace(/^Format:\s*/i, "").split(",").map((s) => s.trim());
    } else if (/^Dialogue:/i.test(line)) {
      const rest = line.replace(/^Dialogue:\s*/i, "");
      const parts = rest.split(",");
      // Text is everything after the (format.length - 1)th comma, since Text is last field
      const startIdx = format.indexOf("Start");
      const endIdx = format.indexOf("End");
      const textIdx = format.indexOf("Text");
      if (startIdx === -1 || endIdx === -1 || textIdx === -1) continue;
      const fixedFields = parts.slice(0, textIdx);
      const textField = parts.slice(textIdx).join(",");
      const start = timeToMs(fixedFields[startIdx]);
      const end = timeToMs(fixedFields[endIdx]);
      const cleanText = textField.replace(/\\N/g, "\n").trim();
      cues.push({ index: cues.length + 1, start, end, text: cleanText });
    }
  }
  return cues;
}

export function parseSubtitle(text, filename = "") {
  const fmt = detectFormat(filename, text);
  if (fmt === "vtt") return parseVtt(text);
  if (fmt === "ass") return parseAss(text);
  if (fmt === "sbv") return parseSbv(text);
  return parseSrt(text);
}

export function toSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${msToSrtTime(c.start)} --> ${msToSrtTime(c.end)}\n${c.text}`)
    .join("\n\n") + "\n";
}

export function toVtt(cues) {
  const body = cues
    .map((c) => `${msToVttTime(c.start)} --> ${msToVttTime(c.end)}\n${c.text}`)
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

export function toPlainText(cues) {
  return cues.map((c) => stripTags(c.text)).join("\n") + "\n";
}

export function cleanCues(cues) {
  return cues.map((c) => ({ ...c, text: stripTags(c.text) }));
}

export function shiftCues(cues, deltaMs) {
  return cues.map((c) => ({
    ...c,
    start: Math.max(0, c.start + deltaMs),
    end: Math.max(0, c.end + deltaMs),
  }));
}

export function partialShiftCues(cues, fromMs, deltaMs) {
  return cues.map((c) =>
    c.start >= fromMs
      ? { ...c, start: Math.max(0, c.start + deltaMs), end: Math.max(0, c.end + deltaMs) }
      : c
  );
}

export function colorizeCues(cues, hexColor) {
  return cues.map((c) => ({
    ...c,
    text: c.text
      .split("\n")
      .map((line) => `<font color="${hexColor}">${line}</font>`)
      .join("\n"),
  }));
}

const VTT_POSITIONS = {
  "top-left": "line:10% position:10% align:start",
  "top-center": "line:10% position:50% align:center",
  "top-right": "line:10% position:90% align:end",
  "middle-left": "line:50% position:10% align:start",
  "middle-center": "line:50% position:50% align:center",
  "middle-right": "line:50% position:90% align:end",
  "bottom-left": "line:90% position:10% align:start",
  "bottom-center": "line:90% position:50% align:center",
  "bottom-right": "line:90% position:90% align:end",
};

export function positionCuesVtt(cues, positionKey) {
  const setting = VTT_POSITIONS[positionKey] || VTT_POSITIONS["bottom-center"];
  return cues.map((c) => ({ ...c, vttSetting: setting }));
}

export function toVttWithPosition(cues) {
  const body = cues
    .map(
      (c) =>
        `${msToVttTime(c.start)} --> ${msToVttTime(c.end)}${c.vttSetting ? " " + c.vttSetting : ""}\n${c.text}`
    )
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

/** Merge two cue lists into one dual-subtitle stream, sorted by start time,
 *  tagging each cue's source so callers can style top/bottom lines. */
export function mergeCueLists(cuesA, cuesB) {
  // Combine overlapping cues from both tracks into one block (text stacked)
  const combined = [];
  const used = new Array(cuesB.length).fill(false);
  for (const a of cuesA) {
    let matchText = null;
    let matched = -1;
    for (let i = 0; i < cuesB.length; i++) {
      if (used[i]) continue;
      const b = cuesB[i];
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (overlap > 0) {
        matchText = b.text;
        matched = i;
        break;
      }
    }
    if (matched >= 0) used[matched] = true;
    combined.push({
      start: a.start,
      end: a.end,
      text: matchText ? `${a.text}\n${matchText}` : a.text,
    });
  }
  cuesB.forEach((b, i) => {
    if (!used[i]) combined.push({ start: b.start, end: b.end, text: b.text });
  });
  combined.sort((x, y) => x.start - y.start);
  return combined.map((c, i) => ({ ...c, index: i + 1 }));
}

export const EXT_BY_FORMAT = { srt: "srt", vtt: "vtt", txt: "txt" };
