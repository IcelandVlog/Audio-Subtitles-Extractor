import { pipeline, env, Tensor } from "@huggingface/transformers";

// We only ever run in the browser (WASM/WebGPU) — never try to read local model
// files from disk, always fetch from the HF Hub CDN (cached by the browser after
// the first run, same as the ffmpeg core assets are cached).
env.allowLocalModels = false;

// onnxruntime-web can spread WASM inference across multiple CPU cores, but only
// when the page is "cross-origin isolated" (COOP/COEP response headers present
// on whatever host serves this app) — that's what unlocks SharedArrayBuffer.
// Without those headers it silently runs single-threaded no matter how many
// cores the machine has, so we only opt in when it's actually available.
if (typeof window !== "undefined" && window.crossOriginIsolated && navigator.hardwareConcurrency) {
  env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency;
}

function modelIdFor(quality, language) {
  // English-only checkpoints are smaller and noticeably faster than the
  // multilingual ones, so use them whenever the person picked English.
  const en = language === "en";
  // Language-ID only, never transcription: OpenAI's own numbers (and
  // everyday experience) show language identification gets *much* more
  // reliable going from tiny/base up to small, especially for
  // lower-resource languages (e.g. Bengali is easy to mix up with
  // Hindi/Urdu/English at the smaller sizes) — and since a single LID pass
  // is just one encoder pass + one decoder step, the jump barely costs
  // anything in latency (it's a bigger download, but that's cached after
  // the first "Detect language" click).
  if (quality === "lid") return "Xenova/whisper-small";
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
 * Identifies the spoken language from a short slice of audio.
 *
 * transformers.js doesn't implement Whisper's built-in auto-detection (it
 * silently falls back to English when no language is given), so we do the
 * same thing OpenAI's own Whisper does under the hood: run the encoder once,
 * take a single decoder step from the `<|startoftranscript|>` token, and
 * compare the logits at just the ~99 language-id tokens. Whichever language
 * token scores highest is the detected language.
 *
 * `offsetSeconds` skips ahead before taking the sample — video/audio files
 * very often open with a studio logo, silent black frame, or instrumental
 * intro before anyone actually speaks, and language-ID run on that lead-in
 * is a common cause of a wrong (or English-biased) guess. Callers that know
 * the clip has room to spare should skip past it.
 *
 * Returns `{ code, confidence }` (code is a Whisper language code like "bn"),
 * or `null` if detection isn't possible for this model/runtime.
 */
export async function detectLanguage(transcriber, audioFloat32, { offsetSeconds = 0 } = {}) {
  try {
    const model = transcriber.model;
    const genConfig = model?.generation_config;
    const langToId = genConfig?.lang_to_id;
    const decoderStart = genConfig?.decoder_start_token_id;
    if (!langToId || decoderStart == null) return null; // e.g. an English-only checkpoint

    // A handful of seconds is plenty for language ID and keeps this fast.
    // Clamp the offset so a clip shorter than the requested skip still
    // leaves something to sample, rather than handing the model silence.
    const totalSeconds = audioFloat32.length / SAMPLE_RATE;
    const safeOffsetSeconds = totalSeconds > offsetSeconds + 5 ? offsetSeconds : 0;
    const offsetSamples = Math.round(safeOffsetSeconds * SAMPLE_RATE);
    const sampleSeconds = Math.min(30, (audioFloat32.length - offsetSamples) / SAMPLE_RATE);
    const sample = audioFloat32.subarray(offsetSamples, offsetSamples + Math.round(sampleSeconds * SAMPLE_RATE));

    const { input_features } = await transcriber.processor(sample);
    const decoder_input_ids = new Tensor("int64", new BigInt64Array([BigInt(decoderStart)]), [1, 1]);
    const output = await model({ input_features, decoder_input_ids });

    const logits = output.logits;
    const vocabSize = logits.dims.at(-1);
    const data = logits.data.slice(-vocabSize); // last (only) position's logits

    let bestCode = null;
    let bestScore = -Infinity;
    const scored = [];
    for (const [token, id] of Object.entries(langToId)) {
      const match = /^<\|([a-z]{2,3})\|>$/.exec(token);
      if (!match) continue;
      const score = data[id];
      scored.push(score);
      if (score > bestScore) {
        bestScore = score;
        bestCode = match[1];
      }
    }
    if (!bestCode) return null;

    // Rough softmax confidence over just the language tokens.
    const max = Math.max(...scored);
    const sumExp = scored.reduce((s, v) => s + Math.exp(v - max), 0);
    const confidence = Math.exp(bestScore - max) / sumExp;

    return { code: bestCode, confidence };
  } catch (err) {
    // Detection is a nice-to-have — if anything about the runtime/model
    // shape doesn't match what we expect, don't blow up the caller. But log
    // it: silently returning null here means every failure just looks like
    // "couldn't confidently identify the language" with zero trace, even in
    // devtools, which makes real bugs (wrong tensor shape, missing session
    // input, WebGPU/CPU tensor mismatch, etc.) impossible to diagnose.
    console.error("[detectLanguage] failed:", err);
    return null;
  }
}

// A single sampled window is fragile: land it on a musical intro, a sound
// effect, silence, or just an unlucky stretch of audio and Whisper's
// language-ID step will confidently return the *wrong* language for the
// whole clip — a well-known weak spot of the smaller checkpoints, not
// something a single "skip the intro" offset can fully guard against.
// Spreading a few sample points across the clip and letting them vote is
// far more robust than trusting whichever window happened to be tried.
// Used as a fallback when we can't measure energy (see pickSpeechyOffsets).
function pickSampleOffsets(totalSeconds) {
  if (totalSeconds <= 20) return [0]; // too short to do anything but use it all
  // Skip the very start (most likely to be a logo/silence/instrumental
  // intro), then take a few more spread through the rest of the clip so one
  // bad window can't single-handedly decide the result.
  const candidates = [
    Math.min(10, totalSeconds * 0.15),
    totalSeconds * 0.45,
    totalSeconds * 0.75,
  ];
  // Keep only offsets that leave enough audio after them to be worth sampling.
  const offsets = candidates.filter((o) => totalSeconds - o > 3);
  return offsets.length ? offsets : [0];
}

const LID_WINDOW_SECONDS = 30; // Whisper's context window; also our per-sample cap
const ENERGY_FRAME_SECONDS = 5;

/**
 * Picks language-ID sample points by loudness instead of blind fixed
 * percentages of the clip. A movie or series episode routinely spends long
 * stretches on score, sound effects, or ambient noise well beyond just the
 * opening — a fixed-percentage offset can land on one of those just as
 * easily as on dialogue, and a low-confidence guess on non-speech audio is,
 * because Whisper's training data skews English, very often "en" — which is
 * exactly the "everything comes back English" symptom this replaces
 * pickSampleOffsets to fix. Splitting the clip into short frames, ranking
 * them by RMS energy, and spreading the picks at least one window apart
 * points every sample at audio that's actually likely to contain speech.
 */
function pickSpeechyOffsets(audioFloat32, totalSeconds, { windowSeconds = LID_WINDOW_SECONDS, count = 4 } = {}) {
  if (totalSeconds <= windowSeconds) return [0];

  const frameSamples = Math.round(ENERGY_FRAME_SECONDS * SAMPLE_RATE);
  const frameCount = Math.floor(audioFloat32.length / frameSamples);
  if (frameCount < 2) return pickSampleOffsets(totalSeconds);

  const energies = new Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const start = i * frameSamples;
    let sumSq = 0;
    for (let j = start; j < start + frameSamples; j++) {
      const v = audioFloat32[j];
      sumSq += v * v;
    }
    energies[i] = Math.sqrt(sumSq / frameSamples);
  }

  const maxEnergy = Math.max(...energies);
  if (maxEnergy <= 0) return pickSampleOffsets(totalSeconds); // true silence throughout

  // Keep frames with meaningful energy relative to the loudest one found —
  // this throws out near-silence/quiet ambience without a fixed absolute
  // threshold that would vary by how the source was mixed/normalized.
  const threshold = maxEnergy * 0.25;
  const loud = energies.map((e, i) => ({ i, e })).filter((f) => f.e >= threshold);
  const pool = loud.length ? loud : energies.map((e, i) => ({ i, e }));

  // Loudest first, then greedily keep picks spread at least one window
  // apart so we don't sample the same speech burst three times over.
  pool.sort((a, b) => b.e - a.e);
  const minGapFrames = Math.ceil(windowSeconds / ENERGY_FRAME_SECONDS);
  const chosenFrames = [];
  for (const f of pool) {
    if (chosenFrames.length >= count) break;
    if (chosenFrames.every((c) => Math.abs(c - f.i) >= minGapFrames)) chosenFrames.push(f.i);
  }
  if (!chosenFrames.length) return pickSampleOffsets(totalSeconds);

  return chosenFrames
    .map((frameIndex) => Math.min((frameIndex * frameSamples) / SAMPLE_RATE, totalSeconds - windowSeconds))
    .sort((a, b) => a - b);
}

// Below this, a "detection" is the model shrugging at silence/music/noise
// rather than an actual read on the language — letting a shrug still cast a
// full vote is how a single bad window drags the result towards whatever
// Whisper defaults to (English) even when every clear-speech window agreed
// on the real language. So votes are weighted by confidence, and anything
// under the floor is dropped rather than counted at all.
const MIN_LID_CONFIDENCE = 0.15;

function tallyDetections(detections) {
  const votes = new Map(); // code -> { count, totalConfidence }
  for (const detected of detections) {
    if (!detected || detected.confidence < MIN_LID_CONFIDENCE) continue;
    const entry = votes.get(detected.code) || { count: 0, totalConfidence: 0 };
    entry.count += 1;
    entry.totalConfidence += detected.confidence;
    votes.set(detected.code, entry);
  }
  if (votes.size === 0) return null;

  // Rank by total confidence accumulated, not raw vote count — one window
  // that clearly recognized the language should outweigh several uncertain
  // ones that happened to agree on something else.
  let bestCode = null;
  let bestTotal = -1;
  let bestAvgConfidence = -1;
  for (const [code, { count, totalConfidence }] of votes) {
    if (totalConfidence > bestTotal) {
      bestCode = code;
      bestTotal = totalConfidence;
      bestAvgConfidence = totalConfidence / count;
    }
  }
  return { code: bestCode, confidence: bestAvgConfidence };
}

/**
 * Identifies the spoken language of a short standalone audio clip — the
 * "Detect language" button on an extracted audio track, as opposed to
 * detectLanguage() above which needs an already-loaded transcriber and
 * already-decoded samples. Uses the "small" multilingual Whisper checkpoint
 * (see modelIdFor's "lid" case) — language ID is only one encoder pass + one
 * decoder step regardless of model size, so the accuracy jump up from
 * tiny/base costs almost nothing here, unlike full transcription where a
 * bigger model matters a lot more (and costs a lot more).
 * Samples several loudness-picked points spread across the clip (see
 * pickSpeechyOffsets) and combines them with tallyDetections, so callers
 * just hand it a Blob and get back `{ code, confidence }` or `null` if
 * nothing could be confidently detected at all.
 */
export async function detectAudioBlobLanguage(blob, { onModelProgress, onSampleProgress } = {}) {
  const transcriber = await getTranscriber("lid", "auto", onModelProgress);
  const audioFloat32 = await decodeAudioTo16kMono(blob);
  const totalSeconds = audioFloat32.length / SAMPLE_RATE;

  const offsets = pickSpeechyOffsets(audioFloat32, totalSeconds);
  const detections = [];
  for (let i = 0; i < offsets.length; i++) {
    detections.push(await detectLanguage(transcriber, audioFloat32, { offsetSeconds: offsets[i] }));
    onSampleProgress?.((i + 1) / offsets.length);
  }
  return tallyDetections(detections);
}

/**
 * Same idea as detectAudioBlobLanguage, but for several separately-extracted
 * short clips pulled from spread-out points in the *original* (often
 * multi-hour) source, rather than one clip that then gets sampled
 * internally. Extracting only a single short slice before detection ever
 * runs means every sample point voting on that slice can still be sitting
 * inside the same unlucky stretch — a long stretch of score or action-scene
 * sound design at whatever point the slice happened to start, for instance,
 * which is a common shape for series/movie audio. Callers that can afford
 * to pull a few short clips instead of one (e.g. via ffmpeg stream-copy,
 * which is cheap) should prefer this for long source files.
 */
export async function detectLanguageAcrossClips(blobs, { onModelProgress, onSampleProgress } = {}) {
  const transcriber = await getTranscriber("lid", "auto", onModelProgress);
  const detections = [];
  for (let i = 0; i < blobs.length; i++) {
    const audioFloat32 = await decodeAudioTo16kMono(blobs[i]);
    const totalSeconds = audioFloat32.length / SAMPLE_RATE;
    // Each clip is already a short, targeted slice, so just pick the
    // loudest window(s) within it rather than re-spreading across it.
    const offsets = pickSpeechyOffsets(audioFloat32, totalSeconds, { count: 1 });
    for (const offsetSeconds of offsets) {
      detections.push(await detectLanguage(transcriber, audioFloat32, { offsetSeconds }));
    }
    onSampleProgress?.((i + 1) / blobs.length);
  }
  return tallyDetections(detections);
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
  {
    quality = "fast",
    language = "auto",
    onModelProgress,
    onTranscribeStart,
    onChunkProgress,
    onLanguageDetected,
  } = {}
) {
  const transcriber = await getTranscriber(quality, language, onModelProgress);

  // "Auto-detect" only picks the multilingual model — it doesn't by itself
  // make Whisper detect anything (see detectLanguage's comment above), so we
  // run our own detection pass and pin the result for every chunk. This is
  // both more accurate (each chunk is short, so per-chunk auto-detection is
  // unreliable) and lets us report the detected language back to the caller.
  let effectiveLanguage = language;
  if (language === "auto") {
    const detected = await detectLanguage(transcriber, audioFloat32);
    if (detected) {
      effectiveLanguage = detected.code;
      onLanguageDetected?.(detected);
    } else {
      effectiveLanguage = null; // let Whisper fall back to its own default
    }
  }

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
      ...(effectiveLanguage ? { language: effectiveLanguage } : {}),
    });

    cues.push(...shapeChunk(result, offsetMs));
    onChunkProgress?.((i + 1) / totalChunks);
  }

  return cues;
}

// Whisper's full multilingual set — 99 languages, each keyed by its 2-letter
// (or, for a few, 3-letter) Whisper language code. Codes double as the
// language-code suffix used in downloaded filenames (movie.bn.srt, etc.).
export const TRANSCRIBE_LANGUAGES = [
  { value: "auto", label: "Auto-detect" },
  // Most commonly requested languages first, then the rest of the set
  // alphabetically by name.
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
  { value: "it", label: "Italian" },
  { value: "hi", label: "Hindi" },
  { value: "bn", label: "Bengali" },
  { value: "ar", label: "Arabic" },
  { value: "ru", label: "Russian" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "af", label: "Afrikaans" },
  { value: "sq", label: "Albanian" },
  { value: "am", label: "Amharic" },
  { value: "hy", label: "Armenian" },
  { value: "as", label: "Assamese" },
  { value: "az", label: "Azerbaijani" },
  { value: "ba", label: "Bashkir" },
  { value: "eu", label: "Basque" },
  { value: "be", label: "Belarusian" },
  { value: "bs", label: "Bosnian" },
  { value: "br", label: "Breton" },
  { value: "bg", label: "Bulgarian" },
  { value: "ca", label: "Catalan" },
  { value: "hr", label: "Croatian" },
  { value: "cs", label: "Czech" },
  { value: "da", label: "Danish" },
  { value: "nl", label: "Dutch" },
  { value: "et", label: "Estonian" },
  { value: "fo", label: "Faroese" },
  { value: "fi", label: "Finnish" },
  { value: "gl", label: "Galician" },
  { value: "ka", label: "Georgian" },
  { value: "el", label: "Greek" },
  { value: "gu", label: "Gujarati" },
  { value: "ht", label: "Haitian Creole" },
  { value: "ha", label: "Hausa" },
  { value: "haw", label: "Hawaiian" },
  { value: "he", label: "Hebrew" },
  { value: "hu", label: "Hungarian" },
  { value: "is", label: "Icelandic" },
  { value: "id", label: "Indonesian" },
  { value: "jw", label: "Javanese" },
  { value: "kn", label: "Kannada" },
  { value: "kk", label: "Kazakh" },
  { value: "km", label: "Khmer" },
  { value: "lo", label: "Lao" },
  { value: "la", label: "Latin" },
  { value: "lv", label: "Latvian" },
  { value: "ln", label: "Lingala" },
  { value: "lt", label: "Lithuanian" },
  { value: "lb", label: "Luxembourgish" },
  { value: "mk", label: "Macedonian" },
  { value: "mg", label: "Malagasy" },
  { value: "ms", label: "Malay" },
  { value: "ml", label: "Malayalam" },
  { value: "mt", label: "Maltese" },
  { value: "mi", label: "Maori" },
  { value: "mr", label: "Marathi" },
  { value: "mn", label: "Mongolian" },
  { value: "my", label: "Myanmar" },
  { value: "ne", label: "Nepali" },
  { value: "no", label: "Norwegian" },
  { value: "nn", label: "Nynorsk" },
  { value: "oc", label: "Occitan" },
  { value: "ps", label: "Pashto" },
  { value: "fa", label: "Persian" },
  { value: "pl", label: "Polish" },
  { value: "pa", label: "Punjabi" },
  { value: "ro", label: "Romanian" },
  { value: "sa", label: "Sanskrit" },
  { value: "sr", label: "Serbian" },
  { value: "sn", label: "Shona" },
  { value: "sd", label: "Sindhi" },
  { value: "si", label: "Sinhala" },
  { value: "sk", label: "Slovak" },
  { value: "sl", label: "Slovenian" },
  { value: "so", label: "Somali" },
  { value: "su", label: "Sundanese" },
  { value: "sw", label: "Swahili" },
  { value: "sv", label: "Swedish" },
  { value: "tl", label: "Tagalog" },
  { value: "tg", label: "Tajik" },
  { value: "ta", label: "Tamil" },
  { value: "tt", label: "Tatar" },
  { value: "te", label: "Telugu" },
  { value: "th", label: "Thai" },
  { value: "bo", label: "Tibetan" },
  { value: "tr", label: "Turkish" },
  { value: "tk", label: "Turkmen" },
  { value: "uk", label: "Ukrainian" },
  { value: "ur", label: "Urdu" },
  { value: "uz", label: "Uzbek" },
  { value: "vi", label: "Vietnamese" },
  { value: "cy", label: "Welsh" },
  { value: "yi", label: "Yiddish" },
  { value: "yo", label: "Yoruba" },
];
