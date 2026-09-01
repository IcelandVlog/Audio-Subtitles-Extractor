import { createWorker } from "tesseract.js";

// Runs OCR over a list of { startMs, endMs, canvas } frames and returns
// cues in the shared { start, end, text } model. Frames that OCR to empty
// text are dropped. Progress callback receives a 0..1 fraction.
export async function ocrFramesToCues(frames, { lang = "eng", onProgress } = {}) {
  if (!frames.length) return [];

  // Tesseract's logger fires "recognizing text" many times per single frame,
  // each with that ONE frame's own 0..1 completion — reporting that value
  // straight through made the overall % reset back down near 0 at the start
  // of every frame instead of climbing steadily, which is what showed up as
  // jittery/flickering progress. Blend it with how many frames are already
  // done so the number is always the true overall fraction and never goes
  // backwards. Also skip pushing an update unless the rounded percent has
  // actually changed, since re-rendering on every one of those dozens of
  // per-frame ticks was adding real overhead and slowing the whole thing down.
  let currentFrameIndex = 0;
  let lastReportedPct = -1;
  const reportProgress = (fraction) => {
    if (!onProgress) return;
    const pct = Math.round(fraction * 100);
    if (pct !== lastReportedPct) {
      lastReportedPct = pct;
      onProgress(fraction);
    }
  };

  const worker = await createWorker(lang, 1, {
    logger: (m) => {
      if (m.status === "recognizing text") {
        reportProgress((currentFrameIndex + m.progress) / frames.length);
      }
    },
  });

  const cues = [];
  try {
    for (let i = 0; i < frames.length; i++) {
      currentFrameIndex = i;
      const frame = frames[i];
      const {
        data: { text },
      } = await worker.recognize(frame.canvas);
      const clean = text.replace(/\s+/g, " ").trim();
      if (clean) {
        cues.push({ start: frame.startMs, end: frame.endMs, text: clean });
      }
      reportProgress((i + 1) / frames.length);
    }
  } finally {
    await worker.terminate();
  }
  return cues;
}
