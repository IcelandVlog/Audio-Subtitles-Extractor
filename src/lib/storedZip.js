/**
 * Minimal ZIP writer (STORE only, no compression).
 *
 * JSZip keeps every added file in JS memory and then builds the whole archive
 * as a second full copy, which is what made "extract all" pile up memory on
 * large videos. This writer keeps each file as a Blob reference and assembles
 * the archive as a Blob made of parts, so the bytes are never copied into a
 * JS buffer. Only one 16 MB chunk at a time is read, to compute each entry's
 * CRC-32 when the entry is added.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const CHUNK_BYTES = 16 * 1024 * 1024;
const ZIP_LIMIT = 0xffffffff; // ZIP64 is not written; fail loudly instead of corrupting

async function crc32Of(blob) {
  let crc = 0xffffffff;
  for (let off = 0; off < blob.size; off += CHUNK_BYTES) {
    const bytes = new Uint8Array(await blob.slice(off, off + CHUNK_BYTES).arrayBuffer());
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export class StoredZip {
  constructor() {
    this.entries = [];
    this.total = 0;
  }

  /** Add one file. Awaits the CRC read, so call sites must `await` it. */
  async add(name, blob) {
    const nameBytes = encoder.encode(name);
    const crc = await crc32Of(blob);
    const offset = this.total;
    const { time, day } = dosDateTime(new Date());
    this.entries.push({ nameBytes, crc, size: blob.size, offset, blob, time, day });
    // local header (30 + name) + data
    this.total += 30 + nameBytes.length + blob.size;
    if (this.total > ZIP_LIMIT) throw new Error("This batch is too large to pack into one zip. Download the files one at a time.");
  }

  /** Build the archive as a Blob. The file data is referenced, not copied. */
  toBlob() {
    const parts = [];
    for (const e of this.entries) {
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true);
      head.setUint16(4, 20, true); // version needed
      head.setUint16(6, 0x0800, true); // UTF-8 names
      head.setUint16(8, 0, true); // STORE
      head.setUint16(10, e.time, true);
      head.setUint16(12, e.day, true);
      head.setUint32(14, e.crc, true);
      head.setUint32(18, e.size, true);
      head.setUint32(22, e.size, true);
      head.setUint16(26, e.nameBytes.length, true);
      head.setUint16(28, 0, true);
      parts.push(new Uint8Array(head.buffer), e.nameBytes, e.blob);
    }

    const cdStart = this.total;
    let cdSize = 0;
    for (const e of this.entries) {
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true); // version made by
      cd.setUint16(6, 20, true); // version needed
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, e.time, true);
      cd.setUint16(14, e.day, true);
      cd.setUint32(16, e.crc, true);
      cd.setUint32(20, e.size, true);
      cd.setUint32(24, e.size, true);
      cd.setUint16(28, e.nameBytes.length, true);
      cd.setUint16(30, 0, true);
      cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true);
      cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true);
      cd.setUint32(42, e.offset, true);
      parts.push(new Uint8Array(cd.buffer), e.nameBytes);
      cdSize += 46 + e.nameBytes.length;
    }

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, cdStart, true);
    parts.push(new Uint8Array(end.buffer));

    return new Blob(parts, { type: "application/zip" });
  }
}
