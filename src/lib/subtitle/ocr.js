import { createWorker } from "tesseract.js";

// Runs OCR over a list of { startMs, endMs, canvas } frames and returns
// cues in the shared { start, end, text } model. Frames that OCR to empty
// text are dropped. Progress callback receives a 0..1 fraction.
//
// Frames are spread across a small pool of Tesseract workers instead of one
// worker doing every frame one at a time. Each tesseract.js worker runs in
// its own Web Worker (real OS thread), so a pool of N workers actually uses
// N CPU cores in parallel — this is the main lever for making a .sup with
// hundreds of frames convert several times faster instead of chewing through
// them serially.
export async function ocrFramesToCues(frames, { lang = "eng", onProgress, concurrency } = {}) {
  if (!frames.length) return [];

  const total = frames.length;
  // Cap the pool: bounded by how many logical cores the machine reports, how
  // many frames there actually are (no point starting more workers than
  // frames), and a hard ceiling of 6 so we don't load 6+ copies of the
  // language model into memory on a huge multi-core machine and make things
  // worse instead of better.
  const poolSize = Math.max(
    1,
    Math.min(concurrency || navigator.hardwareConcurrency || 4, 6, total)
  );

  let completedFrames = 0;
  const inFlightFraction = new Array(poolSize).fill(0);
  let lastReportedPct = -1;
  const reportProgress = () => {
    if (!onProgress) return;
    const sum = inFlightFraction.reduce((a, b) => a + b, 0);
    const fraction = Math.min(1, (completedFrames + sum) / total);
    const pct = Math.round(fraction * 100);
    if (pct !== lastReportedPct) {
      lastReportedPct = pct;
      onProgress(fraction);
    }
  };

  // Start every worker in the pool up front, in parallel, so all of them
  // finish loading the language model before frame processing begins rather
  // than paying that setup cost serially between frames.
  const workers = await Promise.all(
    Array.from({ length: poolSize }, (_, slot) =>
      createWorker(lang, 1, {
        logger: (m) => {
          if (m.status === "recognizing text") {
            inFlightFraction[slot] = m.progress;
            reportProgress();
          }
        },
      })
    )
  );

  // Results are written into a pre-sized array by original frame index, not
  // pushed as they finish, so the output stays in chronological order even
  // though frames complete out of order across the parallel workers.
  const results = new Array(total);
  let nextIndex = 0;

  const runSlot = async (slot) => {
    const worker = workers[slot];
    for (;;) {
      const i = nextIndex++;
      if (i >= total) break;
      const frame = frames[i];
      const {
        data: { text },
      } = await worker.recognize(frame.canvas);
      const clean = text.replace(/\s+/g, " ").trim();
      results[i] = clean ? { start: frame.startMs, end: frame.endMs, text: clean } : null;
      inFlightFraction[slot] = 0;
      completedFrames += 1;
      reportProgress();
    }
  };

  try {
    await Promise.all(workers.map((_, slot) => runSlot(slot)));
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }

  return results.filter(Boolean);
}
