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

// Same crop-to-ink logic as above but scaled by a caller-supplied factor
// instead of always chasing OCR_TARGET_TEXT_HEIGHT. Bold, tightly-kerned
// fonts (blocky all-caps captions, "[groans]"-style bracket text) are the
// case this exists for: the default preprocessing always upscales small
// crops as much as OCR_MAX_UPSCALE allows, but smooth upscaling a font
// that's already bold can blur adjacent strokes into each other and make
// letters run together - which breaks Tesseract's character segmentation
// rather than helping it, and no page-segmentation-mode retry can recover
// from that since the pixels themselves have lost the gaps between
// letters. A milder (or zero) scale keeps those gaps intact.
function preprocessFrameForOcrAtScale(sourceCanvas, scale) {
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
      if (data[(rowOffset + x) * 4] < 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return sourceCanvas;

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const scaledW = Math.max(1, Math.round(cropW * scale));
  const scaledH = Math.max(1, Math.round(cropH * scale));
  const outW = scaledW + OCR_PADDING * 2;
  const outH = scaledH + OCR_PADDING * 2;

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const outCtx = out.getContext("2d");
  outCtx.fillStyle = "#fff";
  outCtx.fillRect(0, 0, outW, outH);
  if (scale !== 1) {
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = "high";
  } else {
    // No resampling at all when we deliberately want the original,
    // unblurred pixel edges (the whole point of the low-scale fallback).
    outCtx.imageSmoothingEnabled = false;
  }
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
//
// Pass `withFrames: true` to also get back EVERY frame (including the ones
// that OCR'd to empty text, and each one's source image as a data URL) - the
// "Inspect" view uses this so a person can review/manually fill in the
// frames OCR missed, instead of only ever seeing the ones that already
// worked.
export async function ocrFramesToCues(frames, { lang = "eng", onProgress, concurrency, withFrames = false } = {}) {
  if (!frames.length) return withFrames ? { cues: [], frames: [] } : [];

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
  //
  // Dictionary correction is also turned off: it's tuned for ordinary prose,
  // and it actively hurts short bracketed sound-effect captions like
  // "[groaning]" or stylised all-caps fonts, where Tesseract's own
  // segmentation step can decide the block "isn't text" and reject it
  // outright before any word-level guessing even happens - which is what
  // produces a fully empty result rather than just a wrong one.
  await Promise.all(
    workers.map((w) =>
      w.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        load_system_dawg: "0",
        load_freq_dawg: "0",
      })
    )
  );

  // Page-segmentation modes tried, in order, for each image variant below.
  // Bracketed sound-effect captions ("[groaning]", "[door creaks]") and
  // heavily stylised/boxed fonts are the main case this rescues:
  // SINGLE_BLOCK's layout analysis sometimes decides a short, symbol-heavy
  // line isn't a text block at all and discards it before recognition runs,
  // where a mode that skips that block-detection step (SPARSE_TEXT) or
  // assumes exactly one line (SINGLE_LINE) still finds the text.
  const PSM_ATTEMPTS = [PSM.SINGLE_BLOCK, PSM.SPARSE_TEXT, PSM.SINGLE_LINE];

  // Results are written into a pre-sized array by original frame index, not
  // pushed as they finish, so the output stays in chronological order even
  // though frames complete out of order across the parallel workers.
  const results = new Array(total);
  const frameRows = withFrames ? new Array(total) : null;
  let nextIndex = 0;

  const runSlot = async (slot) => {
    const worker = workers[slot];
    let currentPsm = PSM.SINGLE_BLOCK; // mirrors the worker's live setting, so we only call setParameters when it's actually changing
    const setPsm = async (psm) => {
      if (psm === currentPsm) return;
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      currentPsm = psm;
    };

    for (;;) {
      const i = nextIndex++;
      if (i >= total) break;
      const frame = frames[i];

      // Image variants tried in order, most-likely-to-work first: the
      // normal upscaled-to-90px crop, then the same crop at a milder scale,
      // then completely unscaled. Bold, tightly-kerned fonts can have their
      // letters blurred into each other by upscaling, which breaks
      // character segmentation in a way no page-segmentation-mode retry
      // can fix - so when the fully-upscaled variant fails outright across
      // every PSM above, backing off the scale (instead of just trying the
      // same blurred pixels a different way) is what actually gives it a
      // second, meaningfully different chance.
      const variants = [
        preprocessFrameForOcr(frame.canvas),
        preprocessFrameForOcrAtScale(frame.canvas, 2),
        preprocessFrameForOcrAtScale(frame.canvas, 1),
      ];

      let clean = "";
      for (let v = 0; v < variants.length && !clean; v++) {
        for (let p = 0; p < PSM_ATTEMPTS.length && !clean; p++) {
          await setPsm(PSM_ATTEMPTS[p]);
          const {
            data: { text },
          } = await worker.recognize(variants[v]);
          clean = text.replace(/\s+/g, " ").trim();
        }
      }
      await setPsm(PSM.SINGLE_BLOCK); // reset so the next frame in this slot starts from the normal, fastest-path setting

      results[i] = clean ? { start: frame.startMs, end: frame.endMs, text: clean } : null;
      if (frameRows) {
        frameRows[i] = {
          start: frame.startMs,
          end: frame.endMs,
          text: clean,
          image: frame.canvas.toDataURL("image/png"),
        };
      }
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

  const cues = results.filter(Boolean);
  return withFrames ? { cues, frames: frameRows } : cues;
}
