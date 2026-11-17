import { extractSpeechSample } from "./ffmpegEngine";

// Skip the opening (logos, title music, cold open) on files long enough to have one.
const SKIP_INTRO_SECONDS = 300;
// Keep clear of the ending credits (usually music) at the very end.
const OUTRO_MARGIN_SECONDS = 60;
const CLIP_SECONDS = 25;
const CLIP_COUNT = 6;

/**
 * Start points spread across the main part of the file, after the intro.
 * Short files (under 10 minutes) are sampled from the beginning.
 */
export function sampleStarts(duration) {
  if (!duration || duration < 60) return [0];
  const skip = duration >= 600 ? Math.min(SKIP_INTRO_SECONDS, duration * 0.1) : 0;
  const end = Math.max(skip, duration - CLIP_SECONDS - OUTRO_MARGIN_SECONDS);
  const span = end - skip;
  if (span <= 0) return [skip];
  return Array.from({ length: CLIP_COUNT }, (_, i) => skip + (span * (i + 0.5)) / CLIP_COUNT);
}

/**
 * Detect the spoken language of one audio stream: take speech-focused clips
 * from the main part of the file and let the language-ID model vote on them.
 * Returns { code, confidence } or null when nothing could be detected.
 */
export async function detectTrackLanguage({ inputName, streamIndex, duration, onProgress, onModelProgress }) {
  const { detectLanguageAcrossClips } = await import("./subtitle/transcribe");
  const starts = sampleStarts(duration);

  const clips = [];
  for (let i = 0; i < starts.length; i++) {
    try {
      clips.push(
        await extractSpeechSample({ inputName, streamIndex, startSeconds: starts[i], seconds: CLIP_SECONDS })
      );
    } catch (err) {
      console.warn("[detectTrackLanguage] clip failed:", err);
    }
    onProgress?.(((i + 1) / starts.length) * 0.5);
  }
  if (clips.length === 0) return null;

  return detectLanguageAcrossClips(clips, {
    onModelProgress,
    onSampleProgress: (p) => onProgress?.(0.5 + p * 0.5),
  });
}
