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
  // Decoded bitmap objects, keyed by their PGS object_id. A composition
  // (PCS) references objects by id rather than embedding them directly, and
  // an object's ODS is only resent when its pixels actually change - so this
  // map is intentionally NOT cleared between compositions/epochs. Clearing
  // it would drop any object a later composition reuses without redefining.
  const objectsById = new Map(); // id -> { width, height, rleBytes }
  let objAssembly = null; // { id, width, height, chunks: Uint8Array[] } - in-progress multi-segment object
  let pendingCompositionStart = null; // pts of the most recent PCS
  // The list of { id, x, y } objects the most recent PCS said should be on
  // screen, waiting to be resolved (via objectsById) once its END arrives.
  let pendingObjectRefs = null;
  let currentComposition = null; // the previous composition's { startMs, objects, palette }, waiting to learn its endMs
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
      // across several: a "first" fragment carrying the id/width/height
      // header, zero or more middle fragments, and a "last" fragment - all
      // of which need to be reassembled into one RLE buffer before
      // decoding. Treating every fragment as if it were a standalone object
      // (the previous behaviour) silently corrupted or truncated any image
      // that got split this way, which is exactly the kind of frame that
      // came out blank or garbled after OCR.
      const objectId = view.getUint16(segStart);
      const flag = view.getUint8(segStart + 3);
      const isFirst = (flag & 0x40) !== 0;
      const isLast = (flag & 0x80) !== 0;

      if (isFirst) {
        const width = view.getUint16(segStart + 7);
        const height = view.getUint16(segStart + 9);
        const chunk = new Uint8Array(arrayBuffer.slice(segStart + 11, segStart + segSize));
        objAssembly = { id: objectId, width, height, chunks: [chunk] };
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
        objectsById.set(objAssembly.id, {
          width: objAssembly.width,
          height: objAssembly.height,
          rleBytes,
        });
        objAssembly = null;
      }
    } else if (segType === 0x16) {
      // PCS - presentation composition: marks the start of a new screen and
      // lists every bitmap object that should be shown for it (each with
      // its own x/y position). A caption can legitimately be made of more
      // than one object at once - e.g. "[groaning]" style bracket captions
      // are sometimes encoded as one object per line, or a boxed line plus
      // its fill - and previously only the single most-recently-decoded
      // object was ever kept, so every object but the last silently
      // vanished from frames that used more than one. Reading the full
      // composition_object list here (instead of just the PTS) lets END
      // recover all of them.
      //
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

      const objectCount = view.getUint8(segStart + 10);
      const refs = [];
      let p = segStart + 11;
      const segEnd = segStart + segSize;
      for (let k = 0; k < objectCount && p + 8 <= segEnd; k++) {
        const objectId = view.getUint16(p);
        const cropFlag = view.getUint8(p + 3);
        const x = view.getUint16(p + 4);
        const y = view.getUint16(p + 6);
        refs.push({ id: objectId, x, y });
        // Optional cropping fields (horizontal/vertical position + width/
        // height, 2 bytes each) only follow this entry when the crop flag
        // is set - skip over them so the next object's id lines up.
        p += 8 + (cropFlag === 0x40 ? 8 : 0);
      }
      pendingObjectRefs = refs;
    } else if (segType === 0x80) {
      // END - marks when the current display set's segments are complete.
      // Resolve every object this composition referenced against what's
      // been decoded so far, and if at least one resolves (i.e. it's
      // showing text, not clearing it), remember the whole set as "on
      // screen" so it can be closed out with the correct end time once we
      // see what comes next.
      if (pendingCompositionStart !== null && pendingObjectRefs && palette) {
        const objects = pendingObjectRefs
          .map((ref) => {
            const obj = objectsById.get(ref.id);
            return obj ? { ...obj, x: ref.x, y: ref.y } : null;
          })
          .filter(Boolean);
        if (objects.length) {
          currentComposition = {
            startMs: pendingCompositionStart,
            objects,
            palette,
          };
        }
      }
      pendingCompositionStart = null;
      pendingObjectRefs = null;
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

function renderFrameToCanvas({ startMs, endMs, objects, palette }) {
  // A frame's composition can be made of several bitmap objects placed at
  // different positions (see the PCS comment above) - size the canvas to
  // the bounding box that covers all of them, then draw each one at its
  // offset relative to that box, instead of assuming there's ever just one.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const o of objects) {
    minX = Math.min(minX, o.x);
    minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x + o.width);
    maxY = Math.max(maxY, o.y + o.height);
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, maxX - minX);
  canvas.height = Math.max(1, maxY - minY);
  const ctx = canvas.getContext("2d");
  // White background so any gap between objects (or the un-inked parts of
  // each object) stays a clean, high-contrast page for OCR.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const o of objects) {
    const indexed = decodeRle(o.rleBytes, o.width, o.height);
    // Rendered on its own transparent tile first (rather than written
    // straight into the shared canvas' pixel buffer) so drawImage below can
    // properly alpha-composite it at its offset instead of overwriting
    // whatever another object already drew in that region.
    const tile = document.createElement("canvas");
    tile.width = Math.max(1, o.width);
    tile.height = Math.max(1, o.height);
    const tileCtx = tile.getContext("2d");
    const imgData = tileCtx.createImageData(tile.width, tile.height);
    for (let i = 0; i < indexed.length; i++) {
      const [, , , a] = palette.get(indexed[i]) || [0, 0, 0, 0];
      // render as plain black-on-white so the OCR engine has a clean, high-contrast image
      const isOpaque = a / 255 > 0.4;
      imgData.data[i * 4 + 0] = 0;
      imgData.data[i * 4 + 1] = 0;
      imgData.data[i * 4 + 2] = 0;
      imgData.data[i * 4 + 3] = isOpaque ? 255 : 0;
    }
    tileCtx.putImageData(imgData, 0, 0);
    ctx.drawImage(tile, o.x - minX, o.y - minY);
  }

  return { startMs, endMs, canvas };
}
