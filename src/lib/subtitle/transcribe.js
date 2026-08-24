import { pipeline, env } from "@huggingface/transformers";

// We only ever run in the browser (WASM/WebGPU) — never try to read local model
// files from disk, always fetch from the HF Hub CDN (cached by the browser after
// the first run, same as the ffmpeg core assets are cached).
env.allowLocalModels = false;

function modelIdFor(quality, language) {
  // English-only checkpoints are smaller and noticeably faster than the
  // multilingual ones, so use them whenever the person picked English.
  const en = language === "english";
  if (quality === "balanced") return en ? "Xenova/whisper-base.en" : "Xenova/whisper-base";
  return en ? "Xenova/whisper-tiny.en" : "Xenova/whisper-tiny";
}

const transcriberCache = {};

/** Lazily create (and cache) the Whisper pipeline for a given quality/language pair. */
async function getTranscriber(quality, language, onModelProgress) {
  const modelId = modelIdFor(quality, language);
  if (transcriberCache[modelId]) return transcriberCache[modelId];

  const makeProgressHandler = () => (data) => {
    if (onModelProgress && data.status === "progress" && data.total) {
      onModelProgress(Math.min(1, data.loaded / data.total));
    }
  };

  const loadPromise = (async () => {
    const attempts = [
      // WebGPU is dramatically faster than CPU/WASM when the browser supports
      // it (Chrome/Edge on most machines) — try it first, silently fall back.
      ...(typeof navigator !== "undefined" && navigator.gpu ? [{ device: "webgpu" }] : []),
      // Default WASM path — let the library choose the right dtype per
      // sub-model (encoder/decoder) automatically.
      {},
      // Last resort: full precision, no quantization at all. Slower/bigger
      // download, but sidesteps any quantized-weight/scale mismatch.
      { dtype: "fp32" },
    ];

    let lastErr;
    for (const opts of attempts) {
      try {
        onModelProgress?.(0);
        return await pipeline("automatic-speech-recognition", modelId, {
          ...opts,
          progress_callback: makeProgressHandler(),
        });
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  })().catch((err) => {
    delete transcriberCache[modelId];
    throw err;
  });

  transcriberCache[modelId] = loadPromise;
  return loadPromise;
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

const SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 28; // just under Whisper's 30s context window

function shapeChunk(chunkResult, offsetMs) {
  const rawChunks =
    chunkResult.chunks && chunkResult.chunks.length
      ? chunkResult.chunks
      : [{ timestamp: [0, null], text: chunkResult.text || "" }];

  return rawChunks
    .filter((c) => c.text && c.text.trim())
    .map((c) => {
      const [startS, endS] = c.timestamp;
      const start = offsetMs + Math.round((startS || 0) * 1000);
      const endGuess = offsetMs + (endS != null ? endS : (startS || 0) + 3) * 1000;
      const end = Math.max(Math.round(endGuess), start + 300);
      return { start, end, text: c.text.trim() };
    });
}

/**
 * Runs Whisper over already-decoded mono/16kHz audio and returns cues in the
 * app's shared { start, end, text } (ms) model, ready for toSrtText/toVttText/etc.
 *
 * The audio is split into our own fixed-length chunks (rather than handing the
 * whole clip to the pipeline's built-in chunking) so we can report real
 * percentage progress after each chunk finishes, instead of one opaque wait.
 */
export async function transcribeToCues(
  audioFloat32,
  { quality = "fast", language = "auto", onModelProgress, onTranscribeStart, onChunkProgress } = {}
) {
  const transcriber = await getTranscriber(quality, language, onModelProgress);
  onTranscribeStart?.();

  const chunkSamples = CHUNK_SECONDS * SAMPLE_RATE;
  const totalChunks = Math.max(1, Math.ceil(audioFloat32.length / chunkSamples));
  const cues = [];

  for (let i = 0; i < totalChunks; i++) {
    const startSample = i * chunkSamples;
    const endSample = Math.min(audioFloat32.length, startSample + chunkSamples);
    const slice = audioFloat32.subarray(startSample, endSample);
    const offsetMs = (startSample / SAMPLE_RATE) * 1000;

    const result = await transcriber(slice, {
      return_timestamps: true,
      ...(language && language !== "auto" ? { language } : {}),
    });

    cues.push(...shapeChunk(result, offsetMs));
    onChunkProgress?.((i + 1) / totalChunks);
  }

  return cues;
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
