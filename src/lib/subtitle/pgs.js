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
  let objData = null; // { width, height, rleBytes }
  let compositionStartMs = null;
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
      // ODS - object definition (bitmap)
      const width = view.getUint16(segStart + 7);
      const height = view.getUint16(segStart + 9);
      const rleBytes = new Uint8Array(
        arrayBuffer.slice(segStart + 11, segStart + segSize)
      );
      objData = { width, height, rleBytes };
    } else if (segType === 0x16) {
      // PCS - presentation composition: marks the start of a new screen
      compositionStartMs = pts;
    } else if (segType === 0x80) {
      // END - marks when the current composition clears
      if (compositionStartMs !== null && objData && palette) {
        frames.push({
          startMs: compositionStartMs,
          endMs: pts,
          width: objData.width,
          height: objData.height,
          rleBytes: objData.rleBytes,
          palette,
        });
      }
      compositionStartMs = null;
      objData = null;
    }

    pos = segStart + segSize;
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
