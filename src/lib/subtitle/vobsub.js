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

// Pixel codes stored in the RLE data are 0 = background, 1 = pattern (usually
// the text), 2 = emphasis-1 and 3 = emphasis-2 (usually outline / anti-alias).
// The SET_COLOR (03) and SET_CONTRAST (04) commands list their four nibbles in
// the OPPOSITE order: [emphasis-2, emphasis-1, pattern, background]. So the
// slot for pixel code `c` is `3 - c`. (Getting this backwards swaps background
// and outline/text, which is what used to turn subtitles into black blobs.)
const slotForCode = (code) => 3 - code;

// Decide which pixel codes are the actual letters. DVD subtitles are normally
// a bright fill with a dark outline (and sometimes a grey anti-alias ring), but
// which of the four codes is the fill differs from disc to disc — so look at
// the palette: among the codes that are actually visible, the bright ones are
// the text and the dark ones are the outline. OCR needs the letters alone,
// otherwise fill + outline merge into one solid blob and comes out as garbage
// (or nothing at all).
function pickInkCodes(colorIdx, alphaIdx, palette) {
  const visible = [];
  for (let code = 0; code < 4; code++) {
    const slot = slotForCode(code);
    if (alphaIdx[slot] <= 3) continue; // (near-)transparent, never drawn
    const rgb = palette[colorIdx[slot]];
    const lum = rgb ? 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] : null;
    visible.push({ code, lum });
  }
  const all = visible.map((v) => v.code);
  if (visible.length === 0) return { ink: [], all };

  const known = visible.filter((v) => v.lum !== null && !Number.isNaN(v.lum));
  const lums = known.map((v) => v.lum);
  const maxLum = lums.length ? Math.max(...lums) : 0;
  const minLum = lums.length ? Math.min(...lums) : 0;

  // No usable palette, or every visible colour looks the same: brightness
  // can't tell fill from outline, so fall back to the DVD convention that the
  // "pattern" pixels (code 1) are the text.
  if (known.length < 2 || maxLum - minLum < 24) {
    return { ink: [visible.some((v) => v.code === 1) ? 1 : visible[0].code], all };
  }

  const threshold = minLum + (maxLum - minLum) * 0.5;
  return { ink: known.filter((v) => v.lum >= threshold).map((v) => v.code), all };
}

function parseSpu(spuBytes, width, height, globalPalette) {
  if (spuBytes.length < 4) return null;
  const view = new DataView(spuBytes.buffer, spuBytes.byteOffset, spuBytes.byteLength);
  const ctrlOffset = view.getUint16(2);
  if (ctrlOffset + 4 > spuBytes.length) return null;

  let colorIdx = null; // [emphasis-2, emphasis-1, pattern, background] palette indices — first SET_COLOR wins
  const alphaIdx = [0, 0, 0, 0]; // same order; highest contrast seen per slot across all control blocks, so fade-in/out blocks don't hide the text
  let area = null;
  let evenOffset = null, oddOffset = null;
  const seen = new Set();

  let cmdPos = ctrlOffset;
  while (cmdPos + 4 <= spuBytes.length && !seen.has(cmdPos)) {
    seen.add(cmdPos);
    const blockStart = cmdPos;
    const nextBlock = (spuBytes[cmdPos + 2] << 8) | spuBytes[cmdPos + 3]; // date(2) + next-offset(2)
    cmdPos += 4;
    let cmd = spuBytes[cmdPos++];
    while (cmd !== 0xff && cmdPos < spuBytes.length) {
      if (cmd === 0x00 || cmd === 0x01 || cmd === 0x02) {
        // display control flags, no operand
      } else if (cmd === 0x03) {
        const b0 = spuBytes[cmdPos++], b1 = spuBytes[cmdPos++];
        if (!colorIdx) colorIdx = [b0 >> 4, b0 & 0xf, b1 >> 4, b1 & 0xf];
      } else if (cmd === 0x04) {
        const b0 = spuBytes[cmdPos++], b1 = spuBytes[cmdPos++];
        const a = [b0 >> 4, b0 & 0xf, b1 >> 4, b1 & 0xf];
        for (let k = 0; k < 4; k++) alphaIdx[k] = Math.max(alphaIdx[k], a[k]);
      } else if (cmd === 0x05) {
        const b = spuBytes.slice(cmdPos, cmdPos + 6);
        cmdPos += 6;
        if (!area) {
          const x1 = (b[0] << 4) | (b[1] >> 4);
          const x2 = ((b[1] & 0xf) << 8) | b[2];
          const y1 = (b[3] << 4) | (b[4] >> 4);
          const y2 = ((b[4] & 0xf) << 8) | b[5];
          area = { x1, x2, y1, y2 };
        }
      } else if (cmd === 0x06) {
        if (evenOffset === null) {
          evenOffset = (spuBytes[cmdPos] << 8) | spuBytes[cmdPos + 1];
          oddOffset = (spuBytes[cmdPos + 2] << 8) | spuBytes[cmdPos + 3];
        }
        cmdPos += 4;
      } else {
        break; // unknown command, bail out of this block
      }
      cmd = spuBytes[cmdPos++];
    }
    if (nextBlock === blockStart) break; // last block points at itself
    cmdPos = nextBlock;
  }

  if (!area || evenOffset === null) return null;
  const w = area.x2 - area.x1 + 1;
  const h = area.y2 - area.y1 + 1;
  if (w <= 0 || h <= 0 || w * h > 4_000_000) return null;

  const rowsPerField = Math.ceil(h / 2);
  const even = decodeRleField(spuBytes.slice(evenOffset), w, rowsPerField);
  const odd = decodeRleField(spuBytes.slice(oddOffset), w, Math.floor(h / 2));

  const { ink, all } = pickInkCodes(colorIdx || [0, 0, 0, 0], alphaIdx, globalPalette);

  // Plain black letters on white — that's what the OCR step expects.
  const draw = (codes) => {
    const isInk = [false, false, false, false];
    for (const code of codes) isInk[code] = true;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(w, h);
    for (let row = 0; row < h; row++) {
      const field = row % 2 === 0 ? even : odd;
      const fieldRow = Math.floor(row / 2);
      for (let col = 0; col < w; col++) {
        const code = field[fieldRow * w + col] || 0;
        const shade = isInk[code] ? 0 : 255;
        const i = (row * w + col) * 4;
        img.data[i] = shade;
        img.data[i + 1] = shade;
        img.data[i + 2] = shade;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  };

  const result = { canvas: draw(ink) };
  // Every visible colour as ink (the old behaviour) — OCR only falls back to
  // this when the letters-only image reads as empty.
  if (ink.length !== all.length) result.altCanvas = draw(all);
  return result;
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
      const parsed = parseSpu(spu, width, height, palette);
      if (parsed) {
        frames.push({ startMs: ms, endMs: nextMs, ...parsed });
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
