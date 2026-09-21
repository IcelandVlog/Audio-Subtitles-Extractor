// Pure functions that operate on the shared cue model: [{ start, end, text }]

export function stripTags(str) {
  return str
    .replace(/<\/?[a-zA-Z][^>]*>/g, "") // <b>, <i>, <u>, <font ...>, etc.
    .replace(/\{[^}]*\}/g, "") // leftover ASS-style override tags
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cuesToPlainText(cues) {
  return cues
    .map((c) => stripTags(c.text))
    .filter(Boolean)
    .join("\n\n")
    .concat("\n");
}

export function shiftCues(cues, offsetMs) {
  return cues.map((c) => ({
    ...c,
    start: Math.max(0, c.start + offsetMs),
    end: Math.max(0, c.end + offsetMs),
  }));
}

// fromIndex/toIndex are 1-based, inclusive, matching what a user sees ("cue #4 to #10")
export function partialShiftCues(cues, offsetMs, fromIndex, toIndex) {
  const from = Math.max(1, fromIndex || 1);
  const to = Math.min(cues.length, toIndex || cues.length);
  return cues.map((c, i) => {
    const n = i + 1;
    if (n < from || n > to) return c;
    return {
      ...c,
      start: Math.max(0, c.start + offsetMs),
      end: Math.max(0, c.end + offsetMs),
    };
  });
}

export function cleanCues(cues) {
  const cleaned = [];
  let prevKey = null;
  for (const c of cues) {
    const text = stripTags(c.text);
    if (!text) continue;
    // drop exact back-to-back duplicates (common export glitch)
    const key = `${text}`;
    if (key === prevKey && cleaned.length) {
      cleaned[cleaned.length - 1].end = Math.max(cleaned[cleaned.length - 1].end, c.end);
      continue;
    }
    if (c.end <= c.start) continue; // drop zero/negative-length junk cues
    cleaned.push({ start: c.start, end: c.end, text });
    prevKey = key;
  }
  return cleaned;
}

// Merge two cue tracks.
// mode "dual": overlapping cues from both tracks are combined into one bilingual cue.
// mode "sequential": track B is appended after track A, its timestamps shifted
//   to start `gapMs` after track A's last cue ends.
export function mergeCues(cuesA, cuesB, mode = "dual", gapMs = 1000) {
  if (mode === "sequential") {
    const lastEnd = cuesA.length ? cuesA[cuesA.length - 1].end : 0;
    const offset = lastEnd + gapMs;
    const shiftedB = cuesB.map((c) => ({ ...c, start: c.start + offset, end: c.end + offset }));
    return [...cuesA, ...shiftedB].sort((a, b) => a.start - b.start);
  }

  // dual: pair by time overlap
  const used = new Set();
  const merged = [];
  for (const a of cuesA) {
    const overlaps = cuesB.filter(
      (b, i) => !used.has(i) && a.start < b.end && a.end > b.start
    );
    if (overlaps.length) {
      overlaps.forEach((b) => used.add(cuesB.indexOf(b)));
      const start = Math.min(a.start, ...overlaps.map((b) => b.start));
      const end = Math.max(a.end, ...overlaps.map((b) => b.end));
      const text = [a.text, ...overlaps.map((b) => b.text)].join("\n");
      merged.push({ start, end, text });
    } else {
      merged.push(a);
    }
  }
  cuesB.forEach((b, i) => {
    if (!used.has(i)) merged.push(b);
  });
  return merged.sort((a, b) => a.start - b.start);
}

// Concatenate any number of cue tracks in order, each starting `gapMs` after
// the previous one ends. Generalizes mergeCues(..., "sequential") to N files —
// for exactly two tracks the result is identical to the two-file version.
export function mergeCuesSequential(cuesList, gapMs = 1000) {
  const merged = [];
  let offset = 0;
  for (const cues of cuesList) {
    const shifted = cues.map((c) => ({ ...c, start: c.start + offset, end: c.end + offset }));
    merged.push(...shifted);
    const lastEnd = shifted.length ? shifted[shifted.length - 1].end : offset;
    offset = lastEnd + gapMs;
  }
  return merged;
}

// Best-effort re-encode to UTF-8 for subtitle files saved in a legacy charset.
const FALLBACK_ENCODINGS = [
  "windows-1252",
  "iso-8859-1",
  "windows-1251",
  "windows-1256",
  "iso-8859-6",
  "gb18030",
  "big5",
  "shift_jis",
  "euc-kr",
];

function decodeQualityScore(str) {
  // Fewer replacement/control characters = better guess.
  let bad = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (ch === "\uFFFD" || (code < 32 && code !== 9 && code !== 10 && code !== 13)) bad++;
  }
  return bad;
}

export function bytesToUtf8Text(arrayBuffer) {
  // Already valid UTF-8?
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(arrayBuffer);
  } catch {
    // fall through
  }

  let best = null;
  let bestScore = Infinity;
  for (const enc of FALLBACK_ENCODINGS) {
    try {
      const text = new TextDecoder(enc).decode(arrayBuffer);
      const score = decodeQualityScore(text);
      if (score < bestScore) {
        bestScore = score;
        best = text;
      }
    } catch {
      // encoding not supported by this browser, skip
    }
  }
  if (best !== null) return best;
  // last resort: lossy UTF-8 decode
  return new TextDecoder("utf-8", { fatal: false }).decode(arrayBuffer);
}
