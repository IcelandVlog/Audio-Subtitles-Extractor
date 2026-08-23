// Best-effort VobSub (.idx + .sub) decoder. This is the DVD-era bitmap
// subtitle format: .idx holds a text index (timestamps + a 16-colour
// palette), .sub is an MPEG program stream carrying the actual RLE-encoded
// bitmaps as private_stream_1 packets.

function parseIdx(idxText) {
  const lines = idxText.split(/\r?\n/);
  let width = 720, height = 480;
  let palette = [];
  const timestamps = []; // { ms, filepos }

  for (const line of lines) {
    const sizeM = line.match(/^size:\s*(\d+)x(\d+)/i);
    if (sizeM) {
      width = Number(sizeM[1]);
      height = Number(sizeM[2]);
    }
    const palM = line.match(/^palette:\s*(.+)$/i);
    if (palM) {
      palette = palM[1].split(",").map((h) => {
        const hex = h.trim();
        return [
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16),
        ];
      });
    }
    const tsM = line.match(/^timestamp:\s*(\d+):(\d{2}):(\d{2}):(\d{3}),\s*filepos:\s*([0-9a-fA-F]+)/i);
    if (tsM) {
      const ms =
        Number(tsM[1]) * 3600000 +
        Number(tsM[2]) * 60000 +
        Number(tsM[3]) * 1000 +
        Number(tsM[4]);
      timestamps.push({ ms, filepos: parseInt(tsM[5], 16) });
    }
  }
  return { width, height, palette, timestamps };
}

// Reads 4-bit nibbles from a byte buffer, tracking byte alignment per scanline.
class NibbleReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.bitPos = 0; // in nibbles
  }
  next() {
    const byteIndex = this.bitPos >> 1;
    if (byteIndex >= this.bytes.length) return 0;
    const byte = this.bytes[byteIndex];
    const nibble = this.bitPos % 2 === 0 ? byte >> 4 : byte & 0x0f;
    this.bitPos++;
    return nibble;
  }
  alignToByte() {
    if (this.bitPos % 2 !== 0) this.bitPos++;
  }
}

function decodeRleField(bytes, width, rows) {
  const reader = new NibbleReader(bytes);
  const out = new Uint8Array(width * rows);
  for (let row = 0; row < rows; row++) {
    let col = 0;
    while (col < width) {
      let val = reader.next();
      if (val < 0x4) {
        val = (val << 4) | reader.next();
        if (val < 0x10) {
          val = (val << 4) | reader.next();
          if (val < 0x40) {
            val = (val << 4) | reader.next();
            if (val === 0) {
              // end-of-line marker: fill remainder with background (index 0)
              col = width;
              break;
            }
          }
        }
      }
      const run = val >> 2;
      const color = val & 0x3;
      const n = Math.min(run || width - col, width - col);
      for (let i = 0; i < n; i++) out[row * width + col + i] = color;
      col += n;
      if (run === 0) break; // guard against infinite loop on malformed data
    }
    reader.alignToByte();
  }
  return out;
}

function findPacksFromOffset(subBytes, startOffset) {
  // Walk the MPEG-PS stream starting near `startOffset`, collecting every
  // private_stream_1 (0xBD) payload that belongs to the same SPU packet
  // (SPU packets can span multiple PES packets).
  let pos = startOffset;
  const collected = [];
  let expectedSize = null;
  let gathered = 0;

  while (pos < subBytes.length - 4 && (expectedSize === null || gathered < expectedSize)) {
    if (!(subBytes[pos] === 0 && subBytes[pos + 1] === 0 && subBytes[pos + 2] === 1)) {
      pos++;
      continue;
    }
    const streamId = subBytes[pos + 3];
    if (streamId === 0xba) {
      // pack header, fixed 14 bytes (assume no stuffing beyond standard)
      pos += 14;
      continue;
    }
    if (streamId === 0xbd) {
      const pesLen = (subBytes[pos + 4] << 8) | subBytes[pos + 5];
      const headerDataLen = subBytes[pos + 8];
      const payloadStart = pos + 9 + headerDataLen;
      const payloadEnd = pos + 6 + pesLen;
      const payload = subBytes.slice(payloadStart + 1, payloadEnd); // +1 skips substream id byte
      if (expectedSize === null && payload.length >= 2) {
        expectedSize = (payload[0] << 8) | payload[1];
      }
      collected.push(payload);
      gathered += payload.length;
      pos = payloadEnd;
      continue;
    }
    pos++;
  }

  const combined = new Uint8Array(gathered);
  let off = 0;
  for (const p of collected) {
    combined.set(p, off);
    off += p.length;
  }
  return combined;
}

function parseSpu(spuBytes, width, height, globalPalette) {
  if (spuBytes.length < 4) return null;
  const view = new DataView(spuBytes.buffer, spuBytes.byteOffset, spuBytes.byteLength);
  const ctrlOffset = view.getUint16(2);
  if (ctrlOffset + 4 > spuBytes.length) return null;

  let cmdPos = ctrlOffset;
  let colorIdx = [0, 0, 0, 0];
  let alphaIdx = [0, 0, 0, 0];
  let area = null;
  let evenOffset = null, oddOffset = null;
  const seen = new Set();

  while (cmdPos < spuBytes.length && !seen.has(cmdPos)) {
    seen.add(cmdPos);
    cmdPos += 4; // skip date(2) + next-offset(2); we walk sequentially instead
    let cmd = spuBytes[cmdPos++];
    while (cmd !== 0xff && cmdPos < spuBytes.length) {
      if (cmd === 0x00 || cmd === 0x01 || cmd === 0x02) {
        // display control flags, no operand
      } else if (cmd === 0x03) {
        const b0 = spuBytes[cmdPos++], b1 = spuBytes[cmdPos++];
        colorIdx = [b0 >> 4, b0 & 0xf, b1 >> 4, b1 & 0xf];
      } else if (cmd === 0x04) {
        const b0 = spuBytes[cmdPos++], b1 = spuBytes[cmdPos++];
        alphaIdx = [b0 >> 4, b0 & 0xf, b1 >> 4, b1 & 0xf];
      } else if (cmd === 0x05) {
        const b = spuBytes.slice(cmdPos, cmdPos + 6);
        cmdPos += 6;
        const x1 = (b[0] << 4) | (b[1] >> 4);
        const x2 = ((b[1] & 0xf) << 8) | b[2];
        const y1 = (b[3] << 4) | (b[4] >> 4);
        const y2 = ((b[4] & 0xf) << 8) | b[5];
        area = { x1, x2, y1, y2 };
      } else if (cmd === 0x06) {
        evenOffset = (spuBytes[cmdPos] << 8) | spuBytes[cmdPos + 1];
        oddOffset = (spuBytes[cmdPos + 2] << 8) | spuBytes[cmdPos + 3];
        cmdPos += 4;
      } else {
        break; // unknown command, bail out of this block
      }
      cmd = spuBytes[cmdPos++];
    }
    break; // one command block is enough for a static subtitle frame
  }

  if (!area || evenOffset === null) return null;
  const w = area.x2 - area.x1 + 1;
  const h = area.y2 - area.y1 + 1;
  if (w <= 0 || h <= 0 || w * h > 4_000_000) return null;

  const rowsPerField = Math.ceil(h / 2);
  const even = decodeRleField(spuBytes.slice(evenOffset), w, rowsPerField);
  const odd = decodeRleField(spuBytes.slice(oddOffset), w, Math.floor(h / 2));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);

  for (let row = 0; row < h; row++) {
    const field = row % 2 === 0 ? even : odd;
    const fieldRow = Math.floor(row / 2);
    for (let col = 0; col < w; col++) {
      const localColor = field[fieldRow * w + col] || 0;
      const paletteEntry = colorIdx[localColor];
      const alpha = alphaIdx[localColor];
      const isOpaque = alpha > 3; // alpha is a 4-bit value, 0-15
      const rgb = globalPalette[paletteEntry] || [255, 255, 255];
      const i = (row * w + col) * 4;
      const shade = isOpaque ? 0 : 255;
      void rgb;
      img.data[i] = shade;
      img.data[i + 1] = shade;
      img.data[i + 2] = shade;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export async function parseVobsub(idxText, subArrayBuffer) {
  const { width, height, palette, timestamps } = parseIdx(idxText);
  const subBytes = new Uint8Array(subArrayBuffer);
  const frames = [];

  for (let i = 0; i < timestamps.length; i++) {
    const { ms } = timestamps[i];
    const nextMs = timestamps[i + 1] ? timestamps[i + 1].ms : ms + 3000;
    try {
      const spu = findPacksFromOffset(subBytes, findApproxPackStart(subBytes, i, timestamps));
      const canvas = parseSpu(spu, width, height, palette);
      if (canvas) {
        frames.push({ startMs: ms, endMs: nextMs, canvas });
      }
    } catch {
      // skip unparsable entries rather than failing the whole file
    }
  }
  return frames;
}

// .idx "filepos" values are byte offsets into the .sub file where each
// SPU packet's PES header begins (approximately — some muxers offset by
// the pack header). We search forward from that position for the next
// 0xBD private stream start code to be resilient to small offset drift.
function findApproxPackStart(subBytes, i, timestamps) {
  const target = timestamps[i].filepos;
  const searchLimit = Math.min(subBytes.length - 4, target + 2048);
  for (let p = Math.max(0, target - 32); p < searchLimit; p++) {
    if (subBytes[p] === 0 && subBytes[p + 1] === 0 && subBytes[p + 2] === 1) {
      const id = subBytes[p + 3];
      if (id === 0xba || id === 0xbd) return p;
    }
  }
  return target;
}
