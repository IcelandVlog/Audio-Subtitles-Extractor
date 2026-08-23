import { createWorker } from "tesseract.js";

// Runs OCR over a list of { startMs, endMs, canvas } frames and returns
// cues in the shared { start, end, text } model. Frames that OCR to empty
// text are dropped. Progress callback receives a 0..1 fraction.
export async function ocrFramesToCues(frames, { lang = "eng", onProgress } = {}) {
  if (!frames.length) return [];

  const worker = await createWorker(lang, 1, {
    logger: (m) => {
      if (onProgress && m.status === "recognizing text") {
        onProgress(m.progress);
      }
    },
  });

  const cues = [];
  try {
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const {
        data: { text },
      } = await worker.recognize(frame.canvas);
      const clean = text.replace(/\s+/g, " ").trim();
      if (clean) {
        cues.push({ start: frame.startMs, end: frame.endMs, text: clean });
      }
      if (onProgress) onProgress((i + 1) / frames.length);
    }
  } finally {
    await worker.terminate();
  }
  return cues;
}
