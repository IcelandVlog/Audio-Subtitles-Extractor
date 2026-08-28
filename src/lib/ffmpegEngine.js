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

// Mounting via WORKERFS (below) hands ffmpeg the real File object instead of
// a full in-memory copy, so large inputs are read lazily in byte ranges as
// ffmpeg needs them rather than being duplicated wholesale into the wasm
// heap. That's what lets files well past the ~2GB wasm memory ceiling be
// probed/extracted at all — the whole video is never resident in memory at
// once, only whatever chunk is currently being read.
let mountCounter = 0;

async function mountInputFile(ffmpeg, file) {
  const mountPoint = `/in_${++mountCounter}`;
  await ffmpeg.createDir(mountPoint);
  await ffmpeg.mount("WORKERFS", { files: [file] }, mountPoint);
  // WORKERFS exposes the file under its own original name inside the mount —
  // it can't be renamed, so the ffmpeg input path has to match it exactly.
  return `${mountPoint}/${file.name}`;
}

/** Run `ffmpeg -i` (which always "fails" with no output) purely to read its stream report. */
export function probeFile(file, { onProgress, onUploaded } = {}) {
  return runExclusive(async () => {
    const ffmpeg = await loadEngine();
    const inputName = await mountInputFile(ffmpeg, file);
    // No bulk read happens anymore, so there's no real byte-progress phase —
    // report done immediately and move straight to probing.
    onProgress?.(1);
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

const AUDIO_ENCODERS = {
  mp3: ["-c:a", "libmp3lame", "-q:a", "2"],
  wav: ["-c:a", "pcm_s16le"],
  ogg: ["-c:a", "libvorbis", "-q:a", "5"],
  flac: ["-c:a", "flac"],
  aac: ["-c:a", "aac", "-b:a", "192k"],
};

// Container that can hold a given codec unmodified (for -c:a copy). "mka"
// (Matroska audio) is the catch-all fallback since it can mux almost any
// codec without re-encoding.
const NATIVE_CONTAINER = {
  aac: "aac",
  mp3: "mp3",
  mp2: "mp2",
  flac: "flac",
  vorbis: "ogg",
  opus: "ogg",
  pcm_s16le: "wav",
  pcm_s24le: "wav",
  pcm_s32le: "wav",
  pcm_f32le: "wav",
  pcm_u8: "wav",
  ac3: "ac3",
  eac3: "eac3",
  dts: "dts",
  alac: "m4a",
  wmav2: "wma",
  wmapro: "wma",
};
function nativeContainerFor(codec) {
  return NATIVE_CONTAINER[codec] || "mka";
}

// Which source codecs already satisfy a given requested output format, so we
// can skip re-encoding entirely and just hand back the native-copied file.
const FORMAT_CODECS = {
  mp3: ["mp3"],
  wav: ["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8"],
  ogg: ["vorbis", "opus"],
  flac: ["flac"],
  aac: ["aac"],
};
export function formatMatchesCodec(format, codec) {
  return (FORMAT_CODECS[format] || []).includes(codec);
}

// Reverse of FORMAT_CODECS: given a source codec, which dropdown format is
// its native match. Used to auto-select the format that needs zero
// re-encoding, so the common case never hits the slow convert step at all.
const CODEC_TO_FORMAT = Object.entries(FORMAT_CODECS).reduce((acc, [format, codecs]) => {
  codecs.forEach((c) => {
    acc[c] = format;
  });
  return acc;
}, {});
export function defaultFormatForCodec(codec) {
  return CODEC_TO_FORMAT[codec] || "mp3";
}

/**
 * Extract a single audio stream via stream copy (no re-encode) into whatever
 * container its codec fits natively. This is the "process the original
 * first" step — it only ever demuxes/remuxes, so it's near-instant even on
 * long videos. The result is cached by the caller and reused as the source
 * for any later format conversion, instead of re-reading the whole video.
 */
export function extractAudioNative({ inputName, streamIndex, codec, onProgress }) {
  return runExclusive(async () => {
    const ffmpeg = await loadEngine();
    const extension = nativeContainerFor(codec);
    const outputName = `native_${streamIndex}.${extension}`;

    const progressHandler = ({ progress }) => {
      if (onProgress && Number.isFinite(progress)) onProgress(Math.min(Math.max(progress, 0), 1));
    };
    ffmpeg.on("progress", progressHandler);
    try {
      await ffmpeg.exec([
        "-i",
        inputName,
        "-map",
        `0:${streamIndex}`,
        "-vn",
        "-c:a",
        "copy",
        outputName,
      ]);
      const data = await ffmpeg.readFile(outputName);
      return { blob: new Blob([data.buffer]), extension, codec };
    } finally {
      ffmpeg.off("progress", progressHandler);
      await ffmpeg.deleteFile(outputName).catch(() => {});
    }
  });
}

/**
 * Convert an already-extracted native audio blob (small — just that one
 * track) into the requested format. Re-processes only that small file, never
 * the source video, so switching output format after the first extract is
 * fast regardless of video length.
 */
export function convertAudioFromNative({ nativeBlob, nativeExtension, streamIndex, format, onProgress }) {
  return runExclusive(async () => {
    const ffmpeg = await loadEngine();
    const inputName = `native_in_${streamIndex}.${nativeExtension}`;
    const outputName = `converted_${streamIndex}.${format}`;
    const encoderArgs = AUDIO_ENCODERS[format] || AUDIO_ENCODERS.mp3;

    const data = new Uint8Array(await nativeBlob.arrayBuffer());
    await ffmpeg.writeFile(inputName, data);

    const progressHandler = ({ progress }) => {
      if (onProgress && Number.isFinite(progress)) onProgress(Math.min(Math.max(progress, 0), 1));
    };
    ffmpeg.on("progress", progressHandler);
    try {
      await ffmpeg.exec(["-i", inputName, ...encoderArgs, outputName]);
      const outData = await ffmpeg.readFile(outputName);
      return new Blob([outData.buffer], { type: `audio/${format}` });
    } finally {
      ffmpeg.off("progress", progressHandler);
      await ffmpeg.deleteFile(inputName).catch(() => {});
      await ffmpeg.deleteFile(outputName).catch(() => {});
    }
  });
}

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
  // inputName is "<mountPoint>/<original file name>" (see mountInputFile) —
  // unmount and remove the mount directory itself, not a MEMFS file.
  const mountPoint = inputName.slice(0, inputName.lastIndexOf("/"));
  try {
    await ffmpegInstance.unmount(mountPoint);
  } catch {
    // already unmounted, ignore
  }
  try {
    await ffmpegInstance.deleteDir(mountPoint);
  } catch {
    // already gone, ignore
  }
}
