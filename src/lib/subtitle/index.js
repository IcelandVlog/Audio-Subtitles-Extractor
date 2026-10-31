import { parseAny, toSrtText, toVttText } from "./formats";
import {
  cuesToPlainText,
  shiftCues,
  partialShiftCues,
  cleanCues,
  mergeCues,
  mergeCuesSequential,
  bytesToUtf8Text,
} from "./tools";
import { cuesToPdfBlob } from "./pdf";
import { parsePgs } from "./pgs";
import { parseVobsub } from "./vobsub";
import { ocrFramesToCues } from "./ocr";
import { cuesToPinyin } from "./pinyin";
import { detectSubtitleLanguage } from "./langDetect";
import { compressAudio, readMediaLog } from "../ffmpegEngine";
import { parseMediaInfo, reportToText } from "../mediaInfo";
import { readMkvLanguages } from "../mkvLanguages";
import JSZip from "jszip";
import { languageName } from "../languages";

// Strip what an earlier extraction / detection run added to a subtitle's name
// ("_2", "_2_2_2", ".el", ".pt-br", ".en-en"...) and hand back the clean base name
// plus the language tag that was already there, if any:
//   "Home - NetMirror_2.el.srt" -> { base: "Home - NetMirror", tag: "el" }
//   "Home - NetMirror_2_2.srt"  -> { base: "Home - NetMirror", tag: null }
// The tag is kept so a file whose language can't be re-detected still ends up as
// "Home - NetMirror.el.srt" instead of losing its code.
function splitBaseName(fileName) {
  let b = baseName(fileName);
  let tag = null;
  const rememberTag = (raw) => {
    if (tag || !raw) return;
    const t = raw.toLowerCase();
    // "en-en-en" (duplicate marker) -> "en"; "es-la" / "pt-br" stay as they are
    const rep = t.match(/^([a-z]{2,3})(?:-\1)+$/);
    tag = rep ? rep[1] : t;
  };
  for (let guard = 0; guard < 20; guard++) {
    const before = b;
    const m1 = b.match(/(?:_\d+)+((?:\.[a-z]{2,3}(?:-[a-z0-9]{2,4})*)*)$/i);
    if (m1) {
      const tags = m1[1].split(".").filter(Boolean);
      rememberTag(tags[tags.length - 1]);
      b = b.slice(0, m1.index);
    }
    const m2 = b.match(/^(.+)\.([a-z]{2,3}(?:-[a-z0-9]{2,4})*)$/i);
    if (m2) {
      const first = m2[2].split("-")[0].toLowerCase();
      if (languageName(first) !== first) {
        rememberTag(m2[2]);
        b = m2[1];
      }
    }
    if (b === before) break;
  }
  return { base: b.trim(), tag };
}

const OCR_LANG_FIELD = {
  key: "lang",
  label: "Subtitle language",
  type: "select",
  options: [
    { value: "eng", label: "English" },
    { value: "spa", label: "Spanish" },
    { value: "fra", label: "French" },
    { value: "deu", label: "German" },
    { value: "por", label: "Portuguese" },
    { value: "ben", label: "Bengali" },
    { value: "hin", label: "Hindi" },
    { value: "ara", label: "Arabic" },
    { value: "rus", label: "Russian" },
    { value: "jpn", label: "Japanese" },
    { value: "kor", label: "Korean" },
    { value: "chi_sim", label: "Chinese (Simplified)" },
  ],
  default: "eng",
};

function baseName(filename) {
  return filename.replace(/\.[^.]+$/, "");
}
function download(filename, content, mime) {
  return { filename, blob: content instanceof Blob ? content : new Blob([content], { type: mime }) };
}
async function readText(file) {
  return bytesToUtf8Text(await file.arrayBuffer());
}

export const TOOLS = {
  "convert-to-srt": {
    label: "Convert to Srt",
    category: "converters",
    accept: ".vtt,.ass,.ssa,.sbv,.srt",
    fields: [],
    hint: "Upload a .vtt, .ass/.ssa, or .sbv file — it'll come back as .srt.",
    async run([file]) {
      const text = await readText(file);
      const { cues } = parseAny(file.name, text);
      return download(`${baseName(file.name)}.srt`, toSrtText(cues), "text/plain");
    },
  },

  "convert-to-webvtt": {
    label: "Convert to WebVtt",
    category: "converters",
    accept: ".srt,.ass,.ssa,.sbv,.vtt",
    fields: [],
    hint: "Upload a .srt, .ass/.ssa, or .sbv file — it'll come back as .vtt.",
    async run([file]) {
      const text = await readText(file);
      const { cues } = parseAny(file.name, text);
      return download(`${baseName(file.name)}.vtt`, toVttText(cues), "text/vtt");
    },
  },

  "sup-to-srt": {
    label: "Sup to Srt Converter",
    category: "converters",
    accept: ".sup",
    fields: [OCR_LANG_FIELD],
    beta: true,
    multiFile: true,
    minFiles: 1,
    maxFiles: 30,
    showPercent: true,
    progressLabel: "Running OCR",
    progressSuffix: "this can take a minute",
    hint: "PGS/Blu-ray bitmap subtitles (.sup). Runs OCR in your browser — larger files take a while, and accuracy depends on image quality. Add more than one file to convert them all in one go — they come back as a single zip. Use Inspect afterwards to see every subtitle image next to its OCR'd text and fix anything it got wrong.",
    async run(files, options, onProgress) {
      // Files are still converted one at a time (not in parallel with each
      // other) — each file's OCR pass already spreads its own frames across
      // several workers (see ocrFramesToCues), so running whole files
      // concurrently on top of that would just multiply how many worker
      // pools sit in memory at once for no real speed gain.
      const results = [];
      // Per-file frame-by-frame data (image + OCR text) for the Inspect
      // view — kept separate from `results` (the actual .srt/.zip download)
      // since it includes every frame, not just the ones OCR read text from.
      const inspect = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const buf = await file.arrayBuffer();
        const frames = await parsePgs(buf);
        const { cues, frames: frameRows } = await ocrFramesToCues(frames, {
          lang: options.lang || "eng",
          onProgress: (p) => onProgress?.((i + p) / files.length, { index: i, fraction: p }),
          withFrames: true,
        });
        const srtName = `${baseName(file.name)}.srt`;
        results.push({ name: srtName, blob: new Blob([toSrtText(cues)], { type: "text/plain" }) });
        inspect.push({ fileName: file.name, srtName, frames: frameRows });
      }

      let out;
      if (results.length === 1) {
        out = download(results[0].name, results[0].blob, "text/plain");
      } else {
        const zip = new JSZip();
        for (const r of results) zip.file(r.name, r.blob);
        const zipBlob = await zip.generateAsync({ type: "blob" });
        out = download("sup-to-srt.zip", zipBlob, "application/zip");
      }
      out.inspect = inspect;
      return out;
    },
  },

  "subidx-to-srt": {
    label: "Sub/Idx to Srt Converter",
    category: "converters",
    accept: ".idx,.sub",
    needsPair: true,
    fields: [OCR_LANG_FIELD],
    beta: true,
    showPercent: true,
    progressLabel: "Running OCR",
    progressSuffix: "this can take a minute",
    hint: "DVD VobSub subtitles — upload both the .idx and the .sub file together. Runs OCR in your browser. Use Inspect afterwards to see every subtitle image next to its OCR'd text and fix anything it got wrong.",
    async run(files, options, onProgress) {
      const idxFile = files.find((f) => f.name.toLowerCase().endsWith(".idx"));
      const subFile = files.find((f) => f.name.toLowerCase().endsWith(".sub"));
      if (!idxFile || !subFile) {
        throw new Error("Please add one .idx file and one .sub file.");
      }
      const idxText = await idxFile.text();
      const subBuf = await subFile.arrayBuffer();
      const frames = await parseVobsub(idxText, subBuf);
      // withFrames also returns every decoded frame (image + OCR text) so the
      // Inspect view can show them next to the text and let the person fix it.
      const { cues, frames: frameRows } = await ocrFramesToCues(frames, {
        lang: options.lang || "eng",
        onProgress,
        withFrames: true,
      });
      const srtName = `${baseName(idxFile.name)}.srt`;
      const out = download(srtName, toSrtText(cues), "text/plain");
      out.inspect = [{ fileName: `${baseName(idxFile.name)} (.idx + .sub)`, srtName, frames: frameRows }];
      return out;
    },
  },

  "convert-to-plaintext": {
    label: "Convert to Plain Text",
    category: "converters",
    accept: ".srt,.vtt,.ass,.ssa,.sbv",
    fields: [],
    hint: "Strips all timestamps and formatting, keeping just the dialogue.",
    async run([file]) {
      const text = await readText(file);
      const { cues } = parseAny(file.name, text);
      return download(`${baseName(file.name)}.txt`, cuesToPlainText(cues), "text/plain");
    },
  },

  "convert-to-pdf": {
    label: "Convert to PDF",
    category: "converters",
    accept: ".srt,.vtt,.ass,.ssa,.sbv",
    fields: [],
    hint: "A readable PDF with each line's timestamp and text.",
    async run([file]) {
      const text = await readText(file);
      const { cues } = parseAny(file.name, text);
      const blob = cuesToPdfBlob(cues, baseName(file.name));
      return download(`${baseName(file.name)}.pdf`, blob, "application/pdf");
    },
  },

  "subtitle-shifter": {
    label: "Subtitle Shifter",
    category: "syncing",
    accept: ".srt,.vtt,.ass,.ssa,.sbv",
    fields: [{ key: "offsetMs", label: "Shift by (ms, +/-)", type: "number", default: 0 }],
    hint: "Positive numbers delay the subtitles, negative numbers bring them earlier.",
    async run([file], options) {
      const text = await readText(file);
      const { cues, format } = parseAny(file.name, text);
      const shifted = shiftCues(cues, Number(options.offsetMs) || 0);
      const isVtt = format === "vtt";
      return download(
        `${baseName(file.name)}.${isVtt ? "vtt" : "srt"}`,
        isVtt ? toVttText(shifted) : toSrtText(shifted),
        "text/plain"
      );
    },
  },

  "partial-subtitle-shifter": {
    label: "Partial Subtitle Shifter",
    category: "syncing",
    accept: ".srt,.vtt,.ass,.ssa,.sbv",
    fields: [
      { key: "offsetMs", label: "Shift by (ms, +/-)", type: "number", default: 0 },
      { key: "fromIndex", label: "From cue #", type: "number", default: 1 },
      { key: "toIndex", label: "To cue # (blank = last)", type: "number", default: "" },
    ],
    hint: "Only the cues in the range you pick get shifted; the rest stay put.",
    async run([file], options) {
      const text = await readText(file);
      const { cues, format } = parseAny(file.name, text);
      const shifted = partialShiftCues(
        cues,
        Number(options.offsetMs) || 0,
        Number(options.fromIndex) || 1,
        options.toIndex ? Number(options.toIndex) : cues.length
      );
      const isVtt = format === "vtt";
      return download(
        `${baseName(file.name)}.${isVtt ? "vtt" : "srt"}`,
        isVtt ? toVttText(shifted) : toSrtText(shifted),
        "text/plain"
      );
    },
  },

  "srt-cleaner": {
    label: "Srt Cleaner",
    category: "fixing",
    accept: ".srt,.vtt,.ass,.ssa,.sbv",
    fields: [],
    hint: "Strips HTML/formatting tags, drops empty or junk lines, merges exact duplicate repeats.",
    async run([file]) {
      const text = await readText(file);
      const { cues } = parseAny(file.name, text);
      const cleaned = cleanCues(cues);
      return download(`${baseName(file.name)}.cleaned.srt`, toSrtText(cleaned), "text/plain");
    },
  },

  "convert-to-utf8": {
    label: "Convert to UTF-8",
    category: "fixing",
    accept: ".srt,.vtt,.ass,.ssa,.sbv,.txt",
    fields: [],
    hint: "Auto-detects a legacy encoding (Windows-1252, GB18030, etc.) and re-saves the file as UTF-8.",
    async run([file]) {
      const buf = await file.arrayBuffer();
      const text = bytesToUtf8Text(buf);
      return download(`${baseName(file.name)}.utf8${extOf(file.name)}`, text, "text/plain;charset=utf-8");
    },
  },

  "subtitle-merger": {
    label: "Subtitle Merger",
    category: "other",
    accept: ".srt,.vtt,.ass,.ssa,.sbv",
    multiFile: true,
    minFiles: 2,
    maxFiles: 20,
    fields: [
      {
        key: "mode",
        label: "Merge mode",
        type: "select",
        options: [
          { value: "sequential", label: "Sequential (files play one after another, in order)" },
          { value: "dual", label: "Dual subtitles (only works with exactly 2 files)" },
        ],
        default: "sequential",
      },
      { key: "gapMs", label: "Gap between files (ms)", type: "number", default: 1000 },
    ],
    hint: "Add 2 to 20 subtitle files. Sequential mode plays them back to back, in the order listed below — drag them into place with the ↑/↓ buttons.",
    noteFor(files, options) {
      if (files.length > 2 && options.mode === "dual") {
        return `Dual mode only works with exactly 2 files — merging these ${files.length} files sequentially instead.`;
      }
      return null;
    },
    async run(files, options) {
      if (files.length < 2) throw new Error("Please add at least two subtitle files.");
      const parsed = await Promise.all(
        files.map(async (f) => parseAny(f.name, await readText(f)).cues)
      );
      const gapMs = Number(options.gapMs) || 1000;
      const merged =
        files.length === 2 && options.mode === "dual"
          ? mergeCues(parsed[0], parsed[1], "dual", gapMs)
          : mergeCuesSequential(parsed, gapMs);
      return download(`${baseName(files[0].name)}.merged.srt`, toSrtText(merged), "text/plain");
    },
  },

  "detect-language": {
    label: "Subtitle Language Detector",
    category: "other",
    accept: ".srt,.vtt,.ass,.ssa,.sbv",
    fields: [],
    multiFile: true,
    minFiles: 1,

    maxFiles: 100,

    actionLabel: "Detect",
    showPercent: true,
    progressLabel: "Detecting",
    hint: "Reads the dialogue text and identifies which of 150+ languages it's written in — no audio needed. The file comes back unchanged except for a language-code tag in the filename (movie.bn.srt, movie.en.srt, ...) so players like Plex, Jellyfin, Kodi, and VLC pick up the language automatically. Add more than one file to detect and tag them all in one go.",
    async run(files, options, onProgress) {
      const results = [];
      const seen = new Map();
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const text = await readText(file);
        const { cues, format } = parseAny(file.name, text);
        const detected = detectSubtitleLanguage(cuesToPlainText(cues));
        const isVtt = format === "vtt";
        const ext = isVtt ? "vtt" : "srt";
        const body = isVtt ? toVttText(cues) : toSrtText(cues);

        // Drop the trailing "_2", "_13" ... counter that extraction adds, then
        // tag the language. A second/third subtitle of the same language gets
        // the code repeated (.en, .en-en, .en-en-en) so names stay unique.
        const { base, tag: oldTag } = splitBaseName(file.name);
        // Prefer the freshly detected language; if detection fails, keep the code
        // the file already carried (.en, .el ...) rather than dropping it.
        const code = detected ? detected.code : oldTag;
        let name;
        if (code) {
          const key = `${base}|${code}`;
          const n = (seen.get(key) || 0) + 1;
          seen.set(key, n);
          const tag = Array(n).fill(code).join("-");
          name = `${base}.${tag}.${ext}`;
        } else {
          const key = `${base}|?`;
          const n = (seen.get(key) || 0) + 1;
          seen.set(key, n);
          name = n === 1 ? `${base}.${ext}` : `${base}.${n}.${ext}`;
        }
        const summary = detected
          ? `${name} → ${detected.label} (${detected.code}) · ${Math.round(
              detected.confidence * 100
            )}% confidence`
          : `${name} → couldn't confidently identify the language${oldTag ? ` (kept .${oldTag})` : ""}`;

        results.push({ name, blob: new Blob([body], { type: "text/plain" }), summary });
        onProgress?.((i + 1) / files.length, { index: i, fraction: 1 });
      }

      if (results.length === 1) {
        const out = download(results[0].name, results[0].blob, "text/plain");
        out.note = results[0].summary;
        return out;
      }

      const zip = new JSZip();
      for (const r of results) zip.file(r.name, r.blob);
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const out = download("detected-languages.zip", zipBlob, "application/zip");
      out.note = results.map((r) => r.summary).join("\n");
      return out;
    },
  },

  "color-changer": {
    label: "Color changer",
    category: "other",
    accept: ".srt,.vtt,.ass,.ssa,.sbv",
    fields: [{ key: "color", label: "Text color", type: "color", default: "#ffff00" }],
    hint: "Wraps every line in a color tag. Works in players that render styled SRT/VTT (VLC, most web players).",
    async run([file], options) {
      const text = await readText(file);
      const { cues, format } = parseAny(file.name, text);
      const color = options.color || "#ffffff";
      const colored = cues.map((c) => ({ ...c, text: `<font color="${color}">${c.text}</font>` }));
      const isVtt = format === "vtt";
      return download(
        `${baseName(file.name)}.color.${isVtt ? "vtt" : "srt"}`,
        isVtt ? toVttText(colored) : toSrtText(colored),
        "text/plain"
      );
    },
  },

  "position-changer": {
    label: "Position changer",
    category: "other",
    accept: ".srt,.vtt,.ass,.ssa,.sbv",
    fields: [
      {
        key: "position",
        label: "Position",
        type: "select",
        options: [
          { value: "top", label: "Top" },
          { value: "bottom", label: "Bottom (default)" },
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
          { value: "center", label: "Center" },
        ],
        default: "bottom",
      },
    ],
    hint: "Outputs a WebVTT file with position/line cue settings, honored by HTML5 video and most modern players.",
    async run([file], options) {
      const text = await readText(file);
      const { cues } = parseAny(file.name, text);
      const settings = POSITION_SETTINGS[options.position] || POSITION_SETTINGS.bottom;
      const positioned = cues.map((c) => ({ ...c, settings }));
      return download(`${baseName(file.name)}.positioned.vtt`, toVttText(positioned), "text/vtt");
    },
  },

  "make-pinyin-subtitles": {
    label: "Make Pinyin Subtitles",
    category: "other",
    accept: ".srt,.vtt,.ass,.ssa,.sbv",
    fields: [
      {
        key: "mode",
        label: "Output",
        type: "select",
        options: [
          { value: "bilingual", label: "Chinese + Pinyin" },
          { value: "pinyin", label: "Pinyin only" },
        ],
        default: "bilingual",
      },
      {
        key: "tone",
        label: "Tones",
        type: "select",
        options: [
          { value: "marks", label: "Tone marks (nǐ hǎo)" },
          { value: "numbers", label: "Tone numbers (ni3 hao3)" },
          { value: "none", label: "No tones (ni hao)" },
        ],
        default: "marks",
      },
    ],
    hint: "Converts Chinese subtitle text to Pinyin. Non-Chinese text and punctuation are left as-is.",
    async run([file], options) {
      const text = await readText(file);
      const { cues } = parseAny(file.name, text);
      const converted = cuesToPinyin(cues, {
        mode: options.mode || "bilingual",
        tone: options.tone || "marks",
      });
      return download(`${baseName(file.name)}.pinyin.srt`, toSrtText(converted), "text/plain");
    },
  },

  "compress-audio": {
    label: "Audio Compressor",
    category: "other",
    accept: ".mp3,.wav,.aac,.m4a,.mka,.opus,.ogg,.flac,.wma",
    fields: [
      {
        key: "format",
        label: "Output format",
        type: "select",
        options: [
          { value: "mp3", label: "MP3 (most compatible)" },
          { value: "aac", label: "AAC" },
          { value: "ogg", label: "OGG (Vorbis)" },
        ],
        default: "mp3",
      },
      {
        key: "quality",
        label: "Quality",
        type: "select",
        options: [
          { value: "high", label: "High quality (smallest size cut)" },
          { value: "medium", label: "Balanced (recommended)" },
          { value: "small", label: "Smallest file (more quality loss)" },
        ],
        default: "medium",
      },
      {
        // Files with several audio tracks (e.g. MKA/MKV with multiple languages
        // or commentary) need one chosen; the value is the audio-track index.
        key: "audioTrack",
        label: "Audio track (for multi-track files)",
        type: "select",
        options: [
          { value: "0", label: "Track 1 (default)" },
          { value: "1", label: "Track 2" },
          { value: "2", label: "Track 3" },
          { value: "3", label: "Track 4" },
          { value: "all", label: "All tracks together (saves as .mka)" },
        ],
        default: "0",
      },
    ],
    showPercent: true,
    progressLabel: "Compressing",
    hint: "Re-encodes your audio at a lower bitrate to shrink the file size while keeping it sounding as close to the original as your chosen quality allows. Runs entirely in your browser — the file never leaves your machine.",
    async run([file], options, onProgress) {
      const format = options.format || "mp3";
      const quality = options.quality || "medium";
      const audioTrack = options.audioTrack === "all" ? "all" : Number(options.audioTrack) || 0;
      const { blob, extension } = await compressAudio({ file, format, quality, audioTrack, onProgress });
      return download(`${baseName(file.name)}.compressed.${extension}`, blob, blob.type);
    },
  },
  "video-info": {
    label: "Video Info",
    category: "other",
    accept: ".mp4,.mkv,.mov,.avi,.webm,.m4v,.wmv,.flv,.ts,.mpg,.mpeg,.3gp,.mka,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.wma",
    fields: [],
    showPercent: false,
    progressLabel: "Reading",
    actionLabel: "Check",
    multiFile: true,
    minFiles: 1,
    maxFiles: 30,
    hint: "Shows each file's length, size, frame rate, resolution, bitrate and a quality rating. Only the file header is read, so it is quick and nothing is re-encoded.",
    async run(files, options, onProgress) {
      const reports = [];
      for (let i = 0; i < files.length; i++) {
        if (onProgress) onProgress(i / files.length, { index: i, fraction: 0 });
        // ffmpeg does not report progress while it reads a header, so the
        // per-file percentage is an estimate that climbs smoothly (1, 2, 3...%)
        // and jumps to done when the file finishes.
        const started = Date.now();
        const tick = () => {
          const secs = (Date.now() - started) / 1000;
          const f = Math.min(0.95, 1 - Math.exp(-secs / 1.5));
          if (onProgress) onProgress((i + f) / files.length, { index: i, fraction: f });
        };
        tick();
        const timer = setInterval(tick, 60);
        let log;
        try {
          log = await readMediaLog(files[i]);
        } finally {
          clearInterval(timer);
        }
        const languageByIndex = await readMkvLanguages(files[i]);
        reports.push(parseMediaInfo(log, files[i].size, files[i].name, { languageByIndex }));
        if (onProgress) onProgress((i + 1) / files.length, { index: i, fraction: 1 });
      }
      // One .txt for everything. With several files each file gets its own
      // numbered section inside it, with the comparison at the end.
      const name = files.length === 1 ? `${baseName(files[0].name)}.media-info.txt` : "media-info.txt";
      return { ...download(name, reportToText(reports), "text/plain"), report: reports };

    },
  },
};

const POSITION_SETTINGS = {
  top: "line:10%,align:center",
  bottom: "line:90%,align:center",
  left: "position:10%,align:start",
  right: "position:90%,align:end",
  center: "position:50%,align:center,line:50%",
};

function extOf(filename) {
  const m = filename.match(/\.[^.]+$/);
  return m ? m[0] : ".txt";
}

export const CATEGORY_LABELS = {
  converters: "CONVERTERS",
  syncing: "SYNCING",
  fixing: "FIXING",
  other: "OTHER",
};
