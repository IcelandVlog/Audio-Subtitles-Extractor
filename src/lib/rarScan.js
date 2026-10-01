// Walks the block headers of a .rar (RAR4 and RAR5) and records where every
// *stored* (uncompressed) file's bytes live inside the archive.
//
// Video releases are almost always packed with "store" (-m0) because video
// doesn't compress — so the bytes of each episode are just sitting in the
// archive as-is. For those we skip the unrar engine completely and hand back
// file.slice(offset, offset + size): instant, zero memory, no copying.
//
// Anything unusual (encrypted headers/files, split volumes, compressed
// files) simply isn't added to the map and goes through the normal unrar path.

const norm = (s) => s.replace(/\\/g, "/");
const utf8 = new TextDecoder("utf-8");

function readAt(reader, file, pos, len) {
  const end = Math.min(file.size, pos + len);
  if (end <= pos) return new Uint8Array(0);
  return new Uint8Array(reader.readAsArrayBuffer(file.slice(pos, end)));
}

function u16(b, p) {
  return b[p] | (b[p + 1] << 8);
}
function u32(b, p) {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
}

// RAR5 variable-length int (7 bits per byte, high bit = "more follows").
// Multiplication instead of shifts so values above 2^32 stay exact.
function vint(b, p) {
  let v = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (p + i >= b.length) return null;
    const x = b[p + i];
    v += (x & 0x7f) * mul;
    if (!(x & 0x80)) return { v, len: i + 1 };
    mul *= 128;
  }
  return null;
}

function scanRar5(file, reader) {
  const out = new Map();
  let pos = 8;
  while (pos + 7 <= file.size) {
    const head = readAt(reader, file, pos, 16);
    const sz = vint(head, 4);
    if (!sz || sz.v < 2 || sz.v > 1 << 20) break;
    const total = 4 + sz.len + sz.v;
    const buf = readAt(reader, file, pos, total);
    if (buf.length < total) break;

    let p = 4 + sz.len;
    const type = vint(buf, p);
    if (!type) break;
    p += type.len;
    const flags = vint(buf, p);
    if (!flags) break;
    p += flags.len;
    let extraSize = 0;
    if (flags.v & 0x1) {
      const e = vint(buf, p);
      if (!e) break;
      extraSize = e.v;
      p += e.len;
    }
    let dataSize = 0;
    if (flags.v & 0x2) {
      const d = vint(buf, p);
      if (!d) break;
      dataSize = d.v;
      p += d.len;
    }

    if (type.v === 4) return new Map(); // archive-level encryption: give up on the fast path
    if (type.v === 5) break; // end of archive

    if (type.v === 2) {
      const fflags = vint(buf, p);
      if (!fflags) break;
      p += fflags.len;
      const unp = vint(buf, p);
      if (!unp) break;
      p += unp.len;
      const attr = vint(buf, p);
      if (!attr) break;
      p += attr.len;
      if (fflags.v & 0x2) p += 4; // mtime
      if (fflags.v & 0x4) p += 4; // crc32
      const comp = vint(buf, p);
      if (!comp) break;
      p += comp.len;
      const host = vint(buf, p);
      if (!host) break;
      p += host.len;
      const nlen = vint(buf, p);
      if (!nlen) break;
      p += nlen.len;
      const name = utf8.decode(buf.subarray(p, p + nlen.v));

      const isDir = (fflags.v & 0x1) !== 0;
      const method = Math.floor(comp.v / 128) & 7;
      const split = (flags.v & 0x18) !== 0;
      const sizeUnknown = (fflags.v & 0x8) !== 0;

      // a file-encryption record (type 1) lives in the extra area at the end
      let encrypted = false;
      if (extraSize > 0) {
        let q = total - extraSize;
        while (q < total) {
          const rs = vint(buf, q);
          if (!rs) break;
          const rt = vint(buf, q + rs.len);
          if (!rt) break;
          if (rt.v === 1) encrypted = true;
          q += rs.len + rs.v;
        }
      }

      if (!isDir && method === 0 && !split && !sizeUnknown && !encrypted && dataSize === unp.v) {
        out.set(norm(name), { offset: pos + total, size: unp.v });
      }
    }
    pos += total + dataSize;
  }
  return out;
}

function scanRar4(file, reader) {
  const out = new Map();
  let pos = 7;
  while (pos + 7 <= file.size) {
    const h = readAt(reader, file, pos, 7);
    if (h.length < 7) break;
    const type = h[2];
    const flags = u16(h, 3);
    const hsize = u16(h, 5);
    if (hsize < 7) break;

    if (type === 0x73 && flags & 0x80) return new Map(); // encrypted headers
    if (type === 0x7b) break; // end of archive

    if (type === 0x74) {
      const hb = readAt(reader, file, pos, hsize);
      if (hb.length < hsize || hsize < 32) break;
      let pack = u32(hb, 7);
      let unp = u32(hb, 11);
      const method = hb[25];
      const nameSize = u16(hb, 26);
      let p = 32;
      if (flags & 0x100) {
        pack += u32(hb, 32) * 2 ** 32;
        unp += u32(hb, 36) * 2 ** 32;
        p = 40;
      }
      let nameBytes = hb.subarray(p, p + nameSize);
      const z = nameBytes.indexOf(0);
      if (z >= 0) nameBytes = nameBytes.subarray(0, z);
      const name = utf8.decode(nameBytes);

      const isDir = (flags & 0xe0) === 0xe0;
      const encrypted = (flags & 0x04) !== 0;
      const split = (flags & 0x03) !== 0;
      if (!isDir && method === 0x30 && !encrypted && !split && pack === unp) {
        out.set(norm(name), { offset: pos + hsize, size: unp });
      }
      pos += hsize + pack;
    } else {
      const add = flags & 0x8000 ? u32(readAt(reader, file, pos, 11), 7) : 0;
      pos += hsize + add;
    }
  }
  return out;
}

/**
 * @returns {Map<string, {offset:number, size:number}>} stored files only
 */
export function scanStoredRar(file, reader) {
  const sig = readAt(reader, file, 0, 8);
  const isRar = sig[0] === 0x52 && sig[1] === 0x61 && sig[2] === 0x72 && sig[3] === 0x21;
  if (!isRar) return new Map();
  if (sig[6] === 1 && sig[7] === 0) return scanRar5(file, reader);
  if (sig[6] === 0) return scanRar4(file, reader);
  return new Map();
}
