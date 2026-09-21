// Helpers for turning a DVD/VobSub subtitle stream (ffmpeg codec
// "dvd_subtitle") into the classic .sub + .idx pair.
//
// ffmpeg can *read* VobSub (.idx/.sub) but has no muxer that *writes* it, so
// the pair is assembled in two steps:
//
//   1. ffmpeg stream-copies the track into an MPEG program stream (`-f vob`).
//      That file is byte-for-byte what a .sub file is: private_stream_1
//      packets carrying the untouched DVD SPU bitmaps.
//   2. The .idx text index (header + one "timestamp/filepos" line per subtitle)
//      is generated here, by walking that program stream for the packets that
//      start a new subtitle (the ones carrying a PTS) and, for the header
//      (frame size + 16-colour palette), by reading the track's CodecPrivate
//      out of a tiny throw-away Matroska copy of the same stream.

const IDX_MAGIC = "# VobSub index file, v7 (do not modify this line!)";

// Only used when the source has no palette/size of its own (e.g. a track that
// came straight from a .vob). Same 16 greys/colours most rippers fall back to.
const DEFAULT_SIZE = "size: 720x480";
const DEFAULT_PALETTE =
  "palette: 000000, f0f0f0, cccccc, 999999, 3333fa, 1111bb, fa3333, bb1111, " +
  "33fa33, 11bb11, fafa33, bbbb11, fa33fa, bb11bb, 33fafa, 11bbbb";

// .idx language ids are ISO 639-1 (two letters); ffprobe reports ISO 639-2.
const ISO3_TO_ISO1 = {
  eng: "en", ara: "ar", cze: "cs", ces: "cs", ger: "de", deu: "de", spa: "es",
  fre: "fr", fra: "fr", hin: "hi", hun: "hu", ind: "id", ita: "it", jpn: "ja",
  kor: "ko", pol: "pl", por: "pt", rus: "ru", chi: "zh", zho: "zh", tur: "tr",
  vie: "vi", tha: "th", dut: "nl", nld: "nl", swe: "sv", nor: "no", dan: "da",
  fin: "fi", gre: "el", ell: "el", heb: "he", ben: "bn", ukr: "uk", ron: "ro",
  rum: "ro", bul: "bg", cat: "ca", hrv: "hr", est: "et", isl: "is", ice: "is",
  lav: "lv", lit: "lt", slo: "sk", slk: "sk", slv: "sl", srp: "sr", per: "fa",
  fas: "fa", urd: "ur", tam: "ta", tel: "te", mal: "ml", msa: "ms", may: "ms",
};

function idxLanguage(code) {
  if (!code) return "xx";
  const c = code.toLowerCase();
  if (c.length === 2) return c;
  return ISO3_TO_ISO1[c] || "xx";
}

/**
 * Read the CodecPrivate blob (Matroska element 0x63A2) out of the small .mks
 * ffmpeg wrote for one subtitle stream. For a VobSub track this is the text
 * header of the original .idx: frame size, palette, etc.
 * Returns the text, or null when there's nothing that looks like one.
 */
export function readCodecPrivateText(bytes) {
  const limit = Math.min(bytes.length - 4, 1 << 20); // Tracks{} lives right at the start of the file
  for (let i = 0; i < limit; i++) {
    if (bytes[i] !== 0x63 || bytes[i + 1] !== 0xa2) continue;
    const first = bytes[i + 2];
    let extra = 0;
    while (extra < 4 && !(first & (0x80 >> extra))) extra++;
    if (extra >= 4) continue; // not a plausible (small) size vint
    let size = first & (0xff >> (extra + 1));
    for (let k = 1; k <= extra; k++) size = size * 256 + bytes[i + 2 + k];
    const start = i + 3 + extra;
    if (size <= 0 || size > 65536 || start + size > bytes.length) continue;
    let text = "";
    for (let p = start; p < start + size; p++) text += String.fromCharCode(bytes[p]);
    if (/(^|\n)\s*(size|palette)\s*:/i.test(text)) return text;
  }
  return null;
}

/**
 * Walk an MPEG-2 program stream (the .sub) and list where each subtitle starts.
 * A subtitle can span several PES packets; only the first carries a PTS, so
 * that's the one an .idx line points at. `filepos` is the start of the pack
 * (sector) that packet lives in, which is what VobSub readers seek to.
 */
export function scanSubStream(bytes) {
  const entries = [];
  let pos = 0;
  let packStart = 0;

  while (pos + 6 <= bytes.length) {
    if (bytes[pos] !== 0 || bytes[pos + 1] !== 0 || bytes[pos + 2] !== 1) {
      pos++;
      continue;
    }
    const id = bytes[pos + 3];

    if (id === 0xba) {
      packStart = pos;
      // MPEG-2 pack: 14 bytes + stuffing. MPEG-1 pack: 12 bytes.
      pos += (bytes[pos + 4] & 0xc0) === 0x40 ? 14 + (bytes[pos + 13] & 7) : 12;
      continue;
    }

    const len = (bytes[pos + 4] << 8) | bytes[pos + 5];

    if (id === 0xbd) {
      const ptsFlag = (bytes[pos + 7] >> 6) & 2; // bit set -> PTS present
      if (ptsFlag && pos + 14 <= bytes.length) {
        const p = pos + 9;
        const pts =
          ((bytes[p] >> 1) & 7) * 2 ** 30 +
          bytes[p + 1] * 2 ** 22 +
          (bytes[p + 2] >> 1) * 2 ** 15 +
          bytes[p + 3] * 2 ** 7 +
          (bytes[p + 4] >> 1);
        entries.push({ ms: Math.round(pts / 90), filepos: packStart });
      }
    }
    pos += 6 + len;
  }

  return entries;
}

function stamp(ms) {
  const t = Math.max(0, ms);
  const h = Math.floor(t / 3600000);
  const m = Math.floor(t / 60000) % 60;
  const s = Math.floor(t / 1000) % 60;
  const milli = t % 1000;
  const two = (n) => String(n).padStart(2, "0");
  return `${two(h)}:${two(m)}:${two(s)}:${String(milli).padStart(3, "0")}`;
}

/**
 * Assemble the final .idx text.
 * @param {string|null} headerText  CodecPrivate text from the source (or null)
 * @param {{ms:number, filepos:number}[]} entries  from scanSubStream()
 * @param {string|null} language  ISO 639-2 (or -1) code of the track
 */
export function buildIdx(headerText, entries, language) {
  const header = (headerText || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    // we regenerate the magic line, language block and timestamps ourselves
    .filter((l) => l.trim() !== "" && !l.startsWith("#") && !/^(timestamp|id|langidx)\s*:/i.test(l.trim()));

  if (!header.some((l) => /^size\s*:/i.test(l))) header.unshift(DEFAULT_SIZE);
  if (!header.some((l) => /^palette\s*:/i.test(l))) header.push(DEFAULT_PALETTE);

  const lines = [
    IDX_MAGIC,
    "",
    ...header,
    "",
    "# Language index in use",
    "langidx: 0",
    "",
    `id: ${idxLanguage(language)}, index: 0`,
    ...entries.map((e) => `timestamp: ${stamp(e.ms)}, filepos: ${e.filepos.toString(16).padStart(9, "0")}`),
    "",
  ];
  return lines.join("\r\n");
}
