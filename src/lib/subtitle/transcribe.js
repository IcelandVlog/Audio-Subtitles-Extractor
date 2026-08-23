import { pipeline, env } from "@huggingface/transformers";

// We only ever run in the browser (WASM/WebGPU) — never try to read local model
// files from disk, always fetch from the HF Hub CDN (cached by the browser after
// the first run, same as the ffmpeg core assets are cached).
env.allowLocalModels = false;

const MODEL_BY_QUALITY = {
  fast: "Xenova/whisper-tiny",
  balanced: "Xenova/whisper-base",
};

const transcriberCache = {};

/** Lazily create (and cache) the Whisper pipeline for a given quality tier. */
function getTranscriber(quality, onModelProgress) {
  const modelId = MODEL_BY_QUALITY[quality] || MODEL_BY_QUALITY.fast;
  if (transcriberCache[modelId]) return transcriberCache[modelId];

  const p = pipeline("automatic-speech-recognition", modelId, {
    dtype: "q8",
    progress_callback: (data) => {
      if (onModelProgress && data.status === "progress" && data.total) {
        onModelProgress(Math.min(1, data.loaded / data.total));
      }
    },
  }).catch((err) => {
    delete transcriberCache[modelId];
    throw err;
  });

  transcriberCache[modelId] = p;
  return p;
}

/** Decodes an audio Blob to mono Float32 samples at 16kHz — the format Whisper expects. */
export async function decodeAudioTo16kMono(blob) {
  const buf = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const probeCtx = new AudioCtx();
  let decoded;
  try {
    decoded = await probeCtx.decodeAudioData(buf.slice(0));
  } finally {
    probeCtx.close();
  }

  const targetRate = 16000;
  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * targetRate),
    targetRate
  );
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0).slice();
}

/**
 * Runs Whisper over already-decoded mono/16kHz audio and returns cues in the
 * app's shared { start, end, text } (ms) model, ready for toSrtText/toVttText/etc.
 */
export async function transcribeToCues(
  audioFloat32,
  { quality = "fast", language = "auto", onModelProgress } = {}
) {
  const transcriber = await getTranscriber(quality, onModelProgress);
  const result = await transcriber(audioFloat32, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    ...(language && language !== "auto" ? { language } : {}),
  });

  const chunks =
    result.chunks && result.chunks.length
      ? result.chunks
      : [{ timestamp: [0, null], text: result.text || "" }];

  return chunks
    .filter((c) => c.text && c.text.trim())
    .map((c) => {
      const [startS, endS] = c.timestamp;
      const start = Math.round((startS || 0) * 1000);
      const endGuess = (endS != null ? endS : (startS || 0) + 3) * 1000;
      const end = Math.max(Math.round(endGuess), start + 300);
      return { start, end, text: c.text.trim() };
    });
}

export const TRANSCRIBE_LANGUAGES = [
  { value: "auto", label: "Auto-detect" },
  { value: "english", label: "English" },
  { value: "spanish", label: "Spanish" },
  { value: "french", label: "French" },
  { value: "german", label: "German" },
  { value: "portuguese", label: "Portuguese" },
  { value: "italian", label: "Italian" },
  { value: "hindi", label: "Hindi" },
  { value: "bengali", label: "Bengali" },
  { value: "arabic", label: "Arabic" },
  { value: "russian", label: "Russian" },
  { value: "chinese", label: "Chinese" },
  { value: "japanese", label: "Japanese" },
  { value: "korean", label: "Korean" },
];
