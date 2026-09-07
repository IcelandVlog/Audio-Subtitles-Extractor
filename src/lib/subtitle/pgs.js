// Minimal PGS (Presentation Graphics Stream, the ".sup" bitmap subtitle format
// used by Blu-ray) decoder. Produces a list of { startMs, endMs, canvas } frames
// that can then be OCR'd into text.

function ycbcrToRgb(y, cb, cr) {
  const c = y - 16;
  const d = cb - 128;
  const e = cr - 128;
  const r = clamp((298 * c + 409 * e + 128) >> 8);
  const g = clamp((298 * c - 100 * d - 208 * e + 128) >> 8);
  const b = clamp((298 * c + 516 * d + 128) >> 8);
  return [r, g, b];
}
function clamp(v) {
  return Math.max(0, Math.min(255, v));
}

function decodeRle(data, width, height) {
  // Returns a Uint8ClampedArray RGBA buffer, indexed by the caller's palette.
  const indexed = new Uint8Array(width * height);
  let pos = 0;
  let pixel = 0;
  while (pos < data.length && pixel < width * height) {
    const b0 = data[pos++];
    if (b0 !== 0) {
      indexed[pixel++] = b0;
      continue;
    }
    const flags = data[pos++];
    if (flags === 0) {
      // end of line: pad remainder (already zero-filled)
      const col = pixel % width;
      if (col !== 0) pixel += width - col;
      continue;
    }
    const lengthBits = flags & 0xc0;
    let runLength;
    let color = 0;
    if (lengthBits === 0x00) {
      runLength = flags & 0x3f;
    } else if (lengthBits === 0x40) {
      runLength = ((flags & 0x3f) << 8) | data[pos++];
    } else if (lengthBits === 0x80) {
      runLength = flags & 0x3f;
      color = data[pos++];
    } else {
      runLength = ((flags & 0x3f) << 8) | data[pos++];
      color = data[pos++];
    }
    for (let i = 0; i < runLength && pixel < width * height; i++) {
      indexed[pixel++] = color;
    }
  }
  return indexed;
}

export async function parsePgs(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const len = arrayBuffer.byteLength;
  let pos = 0;

  let palette = null; // Map<id, [r,g,b,a]>
  let objData = null; // { width, height, rleBytes } for the composition currently being assembled
  let objAssembly = null; // { width, height, chunks: Uint8Array[] } - in-progress multi-segment object
  let pendingCompositionStart = null; // pts of the most recent PCS
  let currentComposition = null; // the previous composition's { startMs, width, height, rleBytes, palette }, waiting to learn its endMs
  const frames = [];

  while (pos + 13 <= len) {
    const magic = view.getUint16(pos);
    if (magic !== 0x5047) break; // "PG"
    const pts = view.getUint32(pos + 2) / 90; // 90kHz -> ms
    pos += 10; // magic(2) + pts(4) + dts(4)
    const segType = view.getUint8(pos);
    const segSize = view.getUint16(pos + 1);
    pos += 3;
    const segStart = pos;

    if (segType === 0x14) {
      // PDS - palette definition
      palette = new Map();
      let p = segStart + 2; // skip palette id + version
      const end = segStart + segSize;
      while (p + 5 <= end) {
        const id = view.getUint8(p);
        const y = view.getUint8(p + 1);
        const cr = view.getUint8(p + 2);
        const cb = view.getUint8(p + 3);
        const a = view.getUint8(p + 4);
        const [r, g, b] = ycbcrToRgb(y, cb, cr);
        palette.set(id, [r, g, b, a]);
        p += 5;
      }
    } else if (segType === 0x15) {
      // ODS - object definition (bitmap). Large subtitle images (multi-line
      // dialogue, bigger fonts) don't fit in one ODS segment and get split
      // across several: a "first" fragment carrying the width/height header,
      // zero or more middle fragments, and a "last" fragment - all of which
      // need to be reassembled into one RLE buffer before decoding. Treating
      // every fragment as if it were a standalone object (the previous
      // behaviour) silently corrupted or truncated any image that got split
      // this way, which is exactly the kind of frame that came out blank or
      // garbled after OCR.
      const flag = view.getUint8(segStart + 3);
      const isFirst = (flag & 0x40) !== 0;
      const isLast = (flag & 0x80) !== 0;

      if (isFirst) {
        const width = view.getUint16(segStart + 7);
        const height = view.getUint16(segStart + 9);
        const chunk = new Uint8Array(arrayBuffer.slice(segStart + 11, segStart + segSize));
        objAssembly = { width, height, chunks: [chunk] };
      } else if (objAssembly) {
        const chunk = new Uint8Array(arrayBuffer.slice(segStart + 4, segStart + segSize));
        objAssembly.chunks.push(chunk);
      }

      if (isLast && objAssembly) {
        const total = objAssembly.chunks.reduce((n, c) => n + c.length, 0);
        const rleBytes = new Uint8Array(total);
        let off = 0;
        for (const c of objAssembly.chunks) {
          rleBytes.set(c, off);
          off += c.length;
        }
        objData = { width: objAssembly.width, height: objAssembly.height, rleBytes };
        objAssembly = null;
      }
    } else if (segType === 0x16) {
      // PCS - presentation composition: marks the start of a new screen.
      // A subtitle's true on-screen duration runs from its own PCS until
      // the *next* PCS (whether that next one shows new text or is an empty
      // "clear" composition) - not until its own END segment, which shares
      // the same timestamp as its own PCS and would otherwise always produce
      // a zero-duration cue. So finalize whatever composition was previously
      // pending using this PCS's timestamp as its end time.
      if (currentComposition) {
        frames.push({ ...currentComposition, endMs: pts });
        currentComposition = null;
      }
      pendingCompositionStart = pts;
      objData = null;
    } else if (segType === 0x80) {
      // END - marks when the current display set's segments are complete.
      // If this display set produced an object+palette (i.e. it's showing
      // text, not clearing it), remember it as "on screen" so it can be
      // closed out with the correct end time once we see what comes next.
      if (pendingCompositionStart !== null && objData && palette) {
        currentComposition = {
          startMs: pendingCompositionStart,
          width: objData.width,
          height: objData.height,
          rleBytes: objData.rleBytes,
          palette,
        };
      }
      pendingCompositionStart = null;
    }

    pos = segStart + segSize;
  }

  // File ended while a subtitle was still "on screen" (no trailing empty
  // composition to mark its clear time) - close it out with a sane fallback
  // duration instead of dropping it entirely.
  if (currentComposition) {
    frames.push({ ...currentComposition, endMs: currentComposition.startMs + 4000 });
  }

  return frames.map((f) => renderFrameToCanvas(f));
}

function renderFrameToCanvas({ startMs, endMs, width, height, rleBytes, palette }) {
  const indexed = decodeRle(rleBytes, width, height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < indexed.length; i++) {
    const [, , , a] = palette.get(indexed[i]) || [0, 0, 0, 0];
    // render as plain black-on-white so the OCR engine has a clean, high-contrast image
    const isOpaque = a / 255 > 0.4;
    imgData.data[i * 4 + 0] = isOpaque ? 0 : 255;
    imgData.data[i * 4 + 1] = isOpaque ? 0 : 255;
    imgData.data[i * 4 + 2] = isOpaque ? 0 : 255;
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return { startMs, endMs, canvas };
}
