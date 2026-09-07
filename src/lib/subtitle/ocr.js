import { createWorker, PSM } from "tesseract.js";

// PGS frames are cropped tightly to the subtitle's bounding box in the
// source video and are often quite small (30-60px tall text) - Tesseract's
// accuracy drops off sharply below roughly 100px of text height, and it also
// expects a bit of quiet white margin around the text rather than pixels
// touching the edge of the image. This crops each frame down to its actual
// ink (dropping the mostly-empty padding PGS bitmaps ship with), scales it
// up toward a comfortable OCR text height, and adds a clean white border
// back around the result. Smooth (not nearest-neighbor) upscaling turns the
// renderer's hard black/white edges back into soft grayscale gradients,
// which Tesseract's own thresholding handles better than blown-up jagged
// pixels - both steps measurably cut down on misreads for these small frames.
const OCR_TARGET_TEXT_HEIGHT = 90; // px
const OCR_MAX_UPSCALE = 4;
const OCR_PADDING = 24; // px, added at output scale

function preprocessFrameForOcr(sourceCanvas) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  if (w < 1 || h < 1) return sourceCanvas;
  const srcCtx = sourceCanvas.getContext("2d");
  const { data } = srcCtx.getImageData(0, 0, w, h);

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    for (let x = 0; x < w; x++) {
      // The renderer only ever writes pure black (text) or pure white
      // (background), so a simple threshold reliably finds ink pixels.
      if (data[(rowOffset + x) * 4] < 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // No ink found (shouldn't normally reach here) - nothing to preprocess.
  if (maxX < 0) return sourceCanvas;

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const scale = Math.max(1, Math.min(OCR_MAX_UPSCALE, OCR_TARGET_TEXT_HEIGHT / cropH));
  const scaledW = Math.round(cropW * scale);
  const scaledH = Math.round(cropH * scale);
  const outW = scaledW + OCR_PADDING * 2;
  const outH = scaledH + OCR_PADDING * 2;

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const outCtx = out.getContext("2d");
  outCtx.fillStyle = "#fff";
  outCtx.fillRect(0, 0, outW, outH);
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  outCtx.drawImage(sourceCanvas, minX, minY, cropW, cropH, OCR_PADDING, OCR_PADDING, scaledW, scaledH);
  return out;
}

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
  // Subtitle frames are near-always a small block of one to a few centered
  // lines, never a full page of mixed layout - telling Tesseract that up
  // front (instead of leaving it to guess the page layout per frame) avoids
  // a class of misreads where it tries to segment the image into columns/
  // paragraphs that aren't there.
  await Promise.all(workers.map((w) => w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK })));

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
      const ocrCanvas = preprocessFrameForOcr(frame.canvas);
      const {
        data: { text },
      } = await worker.recognize(ocrCanvas);
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
