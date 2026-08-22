import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const CORE_VERSION = "0.12.6";
const CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

let ffmpegInstance = null;
let loadPromise = null;

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
  })();

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
export async function probeFile(file, onLog) {
  const ffmpeg = await loadEngine();
  const inputName = safeName(file.name);
  await ffmpeg.writeFile(inputName, await fetchFile(file));

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
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const AUDIO_ENCODERS = {
  mp3: ["-c:a", "libmp3lame", "-q:a", "2"],
  wav: ["-c:a", "pcm_s16le"],
  ogg: ["-c:a", "libvorbis", "-q:a", "5"],
  flac: ["-c:a", "flac"],
  aac: ["-c:a", "aac", "-b:a", "192k"],
};

/** Extract the audio track to the requested format. Returns a Blob. */
export async function extractAudio({ inputName, format, onProgress }) {
  const ffmpeg = await loadEngine();
  const outputName = `out.${format}`;
  const encoderArgs = AUDIO_ENCODERS[format] || AUDIO_ENCODERS.mp3;

  const progressHandler = ({ progress }) => {
    if (onProgress && Number.isFinite(progress)) onProgress(Math.min(progress, 1));
  };
  ffmpeg.on("progress", progressHandler);
  try {
    await ffmpeg.exec(["-i", inputName, "-vn", ...encoderArgs, outputName]);
  } finally {
    ffmpeg.off("progress", progressHandler);
  }

  const data = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(outputName);
  return new Blob([data.buffer], { type: `audio/${format}` });
}

/** Extract a subtitle stream. Tries to convert to .srt; falls back to its native container. */
export async function extractSubtitle({ inputName, streamIndex, codec }) {
  const ffmpeg = await loadEngine();
  const isText = SUBTITLE_TEXT_CODECS.has(codec);

  if (isText) {
    const outputName = "subs.srt";
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
  const outputName = "subs.ass";
  await ffmpeg.exec(["-i", inputName, "-map", `0:${streamIndex}`, "-c:s", "copy", outputName]);
  const data = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(outputName);
  return { blob: new Blob([data.buffer]), extension: "ass" };
}

export async function cleanupInput(inputName) {
  if (!ffmpegInstance) return;
  try {
    await ffmpegInstance.deleteFile(inputName);
  } catch {
    // already gone, ignore
  }
}
