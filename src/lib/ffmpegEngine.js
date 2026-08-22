import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

// Served from our own /public folder instead of a third-party CDN — no CORS
// dependency, no external outage/blocking risk, and everything really does
// stay same-origin as requested.
const CORE_BASE = "/ffmpeg-core";

let ffmpegInstance = null;
let loadPromise = null;

// There is exactly one shared ffmpeg.wasm worker for the whole app, so with
// multiple videos and multiple tracks per video in flight, calls to probe/extract
// must run one at a time rather than racing each other on the same worker.
let engineQueue = Promise.resolve();
function runExclusive(task) {
  const result = engineQueue.then(task, task);
  engineQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Lazily create + load the single shared ffmpeg instance. */
export function loadEngine(onLog) {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    if (onLog) {
      ffmpeg.on("log", ({ message }) => onLog(message));
    }
    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    ]);
    await ffmpeg.load({ coreURL, wasmURL });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })().catch((err) => {
    // don't cache a failed load — let the next call retry from scratch
    loadPromise = null;
    throw err;
  });

  return loadPromise;
}

const SUBTITLE_TEXT_CODECS = new Set([
  "subrip",
  "srt",
  "ass",
  "ssa",
  "webvtt",
  "mov_text",
  "text",
]);

/** Extension we'll produce for a subtitle stream, without actually running ffmpeg. */
export function guessSubtitleExtension(codec) {
  return SUBTITLE_TEXT_CODECS.has(codec) ? "srt" : "ass";
}

/** Parse ffprobe/ffmpeg -i stderr output into stream + duration info. */
function parseProbeLog(log) {
  const streams = [];
  let duration = null;

  const durationMatch = log.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
  if (durationMatch) {
    const [, h, m, s] = durationMatch;
    duration = Number(h) * 3600 + Number(m) * 60 + Number(s);
  }

  const streamRegex = /Stream #0:(\d+)(?:\[[^\]]*\])?\(?([a-zA-Z-]*)\)?:\s*(Audio|Video|Subtitle):\s*([^\n,]+)/g;
  let match;
  while ((match = streamRegex.exec(log)) !== null) {
    const [, index, lang, type, codecInfo] = match;
    const codec = codecInfo.trim().split(/[\s,(]/)[0].toLowerCase();
    streams.push({
      index: Number(index),
      type,
      codec,
      language: lang || null,
    });
  }

  return { streams, duration };
}

/** Run `ffmpeg -i` (which always "fails" with no output) purely to read its stream report. */
export function probeFile(file, { onProgress, onUploaded } = {}) {
  return runExclusive(async () => {
    const ffmpeg = await loadEngine();
    const inputName = safeName(file.name);
    const data = await readFileWithProgress(file, onProgress);
    await ffmpeg.writeFile(inputName, data);
    onUploaded?.();

    let log = "";
    const collector = ({ message }) => {
      log += message + "\n";
    };
    ffmpeg.on("log", collector);
    try {
      await ffmpeg.exec(["-i", inputName]);
    } catch {
      // expected: ffmpeg exits non-zero when no output is requested
    } finally {
      ffmpeg.off("log", collector);
    }

    const info = parseProbeLog(log);
    return { inputName, ...info };
  });
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Read a File into memory while reporting real byte-level progress (0..1). */
function readFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (onProgress && e.lengthComputable) {
        onProgress(e.loaded / e.total);
      }
    };
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Couldn't read this file."));
    reader.readAsArrayBuffer(file);
  });
}

const AUDIO_ENCODERS = {
  mp3: ["-c:a", "libmp3lame", "-q:a", "2"],
  wav: ["-c:a", "pcm_s16le"],
  ogg: ["-c:a", "libvorbis", "-q:a", "5"],
  flac: ["-c:a", "flac"],
  aac: ["-c:a", "aac", "-b:a", "192k"],
};

/** Extract a single audio stream (by absolute ffmpeg stream index) to the requested format. */
export function extractAudio({ inputName, streamIndex, format, onProgress }) {
  return runExclusive(async () => {
    const ffmpeg = await loadEngine();
    const outputName = `out_${streamIndex}.${format}`;
    const encoderArgs = AUDIO_ENCODERS[format] || AUDIO_ENCODERS.mp3;
    const mapArgs = Number.isFinite(streamIndex) ? ["-map", `0:${streamIndex}`] : [];

    const progressHandler = ({ progress }) => {
      if (onProgress && Number.isFinite(progress)) onProgress(Math.min(Math.max(progress, 0), 1));
    };
    ffmpeg.on("progress", progressHandler);
    try {
      await ffmpeg.exec(["-i", inputName, ...mapArgs, "-vn", ...encoderArgs, outputName]);
    } finally {
      ffmpeg.off("progress", progressHandler);
    }

    const data = await ffmpeg.readFile(outputName);
    await ffmpeg.deleteFile(outputName);
    return new Blob([data.buffer], { type: `audio/${format}` });
  });
}

/** Extract a subtitle stream. Tries to convert to .srt; falls back to its native container. */
export function extractSubtitle({ inputName, streamIndex, codec, onProgress }) {
  return runExclusive(async () => {
    const ffmpeg = await loadEngine();
    const isText = SUBTITLE_TEXT_CODECS.has(codec);

    const progressHandler = ({ progress }) => {
      if (onProgress && Number.isFinite(progress)) onProgress(Math.min(Math.max(progress, 0), 1));
    };
    ffmpeg.on("progress", progressHandler);

    try {
      if (isText) {
        const outputName = `subs_${streamIndex}.srt`;
        try {
          await ffmpeg.exec(["-i", inputName, "-map", `0:${streamIndex}`, "-c:s", "srt", outputName]);
          const data = await ffmpeg.readFile(outputName);
          await ffmpeg.deleteFile(outputName);
          return { blob: new Blob([data.buffer], { type: "text/srt" }), extension: "srt" };
        } catch {
          // fall through to raw copy below
        }
      }

      // Bitmap or otherwise inconvertible subtitle: copy the stream as-is.
      const outputName = `subs_${streamIndex}.ass`;
      await ffmpeg.exec(["-i", inputName, "-map", `0:${streamIndex}`, "-c:s", "copy", outputName]);
      const data = await ffmpeg.readFile(outputName);
      await ffmpeg.deleteFile(outputName);
      return { blob: new Blob([data.buffer]), extension: "ass" };
    } finally {
      ffmpeg.off("progress", progressHandler);
    }
  });
}

export async function cleanupInput(inputName) {
  if (!ffmpegInstance) return;
  try {
    await ffmpegInstance.deleteFile(inputName);
  } catch {
    // already gone, ignore
  }
}
