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
import { compressAudio } from "../ffmpegEngine";
import { languageLabel } from "../languages";
import JSZip from "jszip";

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
    showPercent: true,
    progressLabel: "Running OCR",
    progressSuffix: "this can take a minute",
    hint: "PGS/Blu-ray bitmap subtitles (.sup). Runs OCR in your browser — larger files take a while, and accuracy depends on image quality.",
    async run([file], options, onProgress) {
      const buf = await file.arrayBuffer();
      const frames = await parsePgs(buf);
      const cues = await ocrFramesToCues(frames, {
        lang: options.lang || "eng",
        onProgress,
      });
      return download(`${baseName(file.name)}.srt`, toSrtText(cues), "text/plain");
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
    hint: "DVD VobSub subtitles — upload both the .idx and the .sub file together. Runs OCR in your browser.",
    async run(files, options, onProgress) {
      const idxFile = files.find((f) => f.name.toLowerCase().endsWith(".idx"));
      const subFile = files.find((f) => f.name.toLowerCase().endsWith(".sub"));
      if (!idxFile || !subFile) {
        throw new Error("Please add one .idx file and one .sub file.");
      }
      const idxText = await idxFile.text();
      const subBuf = await subFile.arrayBuffer();
      const frames = await parseVobsub(idxText, subBuf);
      const cues = await ocrFramesToCues(frames, {
        lang: options.lang || "eng",
        onProgress,
      });
      return download(`${baseName(idxFile.name)}.srt`, toSrtText(cues), "text/plain");
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
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const text = await readText(file);
        const { cues, format } = parseAny(file.name, text);
        const detected = detectSubtitleLanguage(cuesToPlainText(cues));
        const isVtt = format === "vtt";
        const ext = isVtt ? "vtt" : "srt";
        const body = isVtt ? toVttText(cues) : toSrtText(cues);

        const name = detected
          ? `${baseName(file.name)}.${detected.code}.${ext}`
          : `${baseName(file.name)}.${ext}`;
        const summary = detected
          ? `${file.name} → ${detected.label} (${detected.code}) · ${Math.round(
              detected.confidence * 100
            )}% confidence`
          : `${file.name} → couldn't confidently identify the language`;

        results.push({ name, blob: new Blob([body], { type: "text/plain" }), summary });
        onProgress?.((i + 1) / files.length);
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
    accept: ".mp3,.wav,.aac,.m4a,.ogg,.flac,.wma",
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
    ],
    showPercent: true,
    progressLabel: "Compressing",
    hint: "Re-encodes your audio at a lower bitrate to shrink the file size while keeping it sounding as close to the original as your chosen quality allows. Runs entirely in your browser — the file never leaves your machine.",
    async run([file], options, onProgress) {
      const format = options.format || "mp3";
      const quality = options.quality || "medium";
      const { blob, extension } = await compressAudio({ file, format, quality, onProgress });
      return download(`${baseName(file.name)}.compressed.${extension}`, blob, blob.type);
    },
  },

  "detect-audio-language": {
    label: "Audio Language Detector",
    category: "other",
    accept: ".mp3,.wav,.aac,.m4a,.ogg,.flac,.wma",
    fields: [],
    multiFile: true,
    minFiles: 1,
    maxFiles: 50,
    actionLabel: "Detect",
    showPercent: true,
    progressLabel: "Detecting",
    hint: "Loads a small speech-recognition model in your browser and listens to roughly the first 30 seconds of each file to identify the spoken language — no metadata or transcript needed, works on plain audio files too. Each file comes back unchanged except for a language-code tag in the filename (song.bn.mp3, episode.ja.wav, ...) — the same convention players like Plex, Jellyfin, Kodi, and VLC pick up automatically. Add more than one file to detect and tag them all in one go.",
    async run(files, options, onProgress) {
      // Heavy (transformers.js + onnxruntime-web) — only fetched the first
      // time someone actually opens this tool, same as Video → Subtitles.
      const { detectAudioBlobLanguage } = await import("./transcribe");
      const results = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = extOf(file.name);
        let detected = null;
        try {
          detected = await detectAudioBlobLanguage(file);
        } catch (err) {
          console.error(`[detect-audio-language] ${file.name} failed:`, err);
        }

        const name = detected
          ? `${baseName(file.name)}.${detected.code}${ext}`
          : `${baseName(file.name)}${ext}`;
        const summary = detected
          ? `${file.name} → ${languageLabel(detected.code)} (${detected.code}) · ${Math.round(
              detected.confidence * 100
            )}% confidence`
          : `${file.name} → couldn't confidently identify the language`;

        results.push({ name, blob: file, summary });
        onProgress?.((i + 1) / files.length);
      }

      if (results.length === 1) {
        const out = download(results[0].name, results[0].blob, results[0].blob.type || "audio/mpeg");
        out.note = results[0].summary;
        return out;
      }

      const zip = new JSZip();
      for (const r of results) zip.file(r.name, r.blob);
      const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      const out = download("detected-audio-languages.zip", zipBlob, "application/zip");
      out.note = results.map((r) => r.summary).join("\n");
      return out;
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
