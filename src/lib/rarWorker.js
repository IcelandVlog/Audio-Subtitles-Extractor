// Runs inside a Web Worker. Reads a .rar straight off disk in small blocks
// (FileReaderSync is only available in workers) instead of loading the whole
// archive into one giant ArrayBuffer.
//
// node-unrar-js talks to its wasm through synchronous file callbacks
// (open / read / seek / tell / create / write / close). We subclass its
// Extractor and answer them ourselves:
//   - reads come from the original File, 8 MB at a time
//   - writes are staged in a reusable 4 MB buffer and sealed into Blobs
//     (which the browser can keep on disk) — never one contiguous buffer
import { Extractor } from "node-unrar-js/esm/js/Extractor.js";
import { getUnrar } from "node-unrar-js/esm/js/unrar.singleton.js";
import unrarWasmUrl from "node-unrar-js/esm/js/unrar.wasm?url";

const SRC_FD = 1;
const READ_BLOCK = 8 * 1024 * 1024; // archive bytes pulled per disk read
const STAGE_SIZE = 4 * 1024 * 1024; // output staging buffer per file

class BlobExtractor extends Extractor {
  constructor(unrar, file, password = "") {
    super(unrar, password);
    this._filePath = "_source_.rar";
    this.src = file;
    this.srcPos = 0;
    this.cache = null;
    this.cacheStart = 0;
    this.reader = new FileReaderSync();
    this.outs = new Map();
    this.nextFd = 2;
    this.done = null; // last finished output { name, blob }
    // per-operation progress bookkeeping
    this.keepFn = null; // decides which outputs are kept (solid mode discards the rest)
    this.processed = 0;
    this.total = 0;
    this.onProgress = null;
    this.lastProgressAt = 0;
  }

  open(filename) {
    if (filename !== this._filePath) return 0;
    this.srcPos = 0;
    return SRC_FD;
  }

  create(filename) {
    const fd = this.nextFd++;
    const keep = this.keepFn ? this.keepFn(filename) : true;
    this.outs.set(fd, { name: filename, keep, stage: null, len: 0, blobs: [], size: 0 });
    return fd;
  }

  closeFile(fd) {
    if (fd === SRC_FD) {
      this.srcPos = 0;
      return;
    }
    const out = this.outs.get(fd);
    if (!out) return;
    if (out.keep && out.len > 0) out.blobs.push(new Blob([out.stage.subarray(0, out.len)]));
    this.done = { name: out.name, blob: out.keep ? new Blob(out.blobs) : null };
    this.outs.delete(fd);
  }

  read(fd, buf, size) {
    if (fd !== SRC_FD) return -1;
    if (size === 0) return 0;
    const start = this.srcPos;
    if (start + size > this.src.size) return -1; // same contract as the library's own in-memory reader
    const end = start + size;

    const cacheEnd = this.cache ? this.cacheStart + this.cache.byteLength : 0;
    if (!this.cache || start < this.cacheStart || end > cacheEnd) {
      const blockEnd = Math.min(this.src.size, start + Math.max(size, READ_BLOCK));
      this.cache = new Uint8Array(this.reader.readAsArrayBuffer(this.src.slice(start, blockEnd)));
      this.cacheStart = start;
    }
    const off = start - this.cacheStart;
    this.unrar.HEAPU8.set(this.cache.subarray(off, off + size), buf);
    this.srcPos = end;
    return size;
  }

  write(fd, buf, size) {
    const out = this.outs.get(fd);
    if (!out) return false;
    out.size += size;
    this.processed += size;

    if (out.keep) {
      if (!out.stage) out.stage = new Uint8Array(STAGE_SIZE);
      const heap = this.unrar.HEAPU8; // re-read each time: wasm memory can grow
      let p = buf;
      let left = size;
      while (left > 0) {
        const n = Math.min(STAGE_SIZE - out.len, left);
        out.stage.set(heap.subarray(p, p + n), out.len);
        out.len += n;
        p += n;
        left -= n;
        if (out.len === STAGE_SIZE) {
          out.blobs.push(new Blob([out.stage])); // Blob copies the bytes, so the stage can be reused
          out.len = 0;
        }
      }
    }

    if (this.onProgress && this.total) {
      const now = Date.now();
      if (now - this.lastProgressAt > 100) {
        this.lastProgressAt = now;
        this.onProgress(Math.min(1, this.processed / this.total));
      }
    }
    return true;
  }

  tell(fd) {
    return fd === SRC_FD ? this.srcPos : (this.outs.get(fd)?.size ?? -1);
  }

  seek(fd, pos, method) {
    if (fd !== SRC_FD) return true; // output is append-only
    let p;
    if (method === "SET") p = pos;
    else if (method === "CUR") p = this.srcPos + pos;
    else p = this.src.size - pos; // "END"
    if (p < 0 || p > this.src.size) return false;
    this.srcPos = p;
    return true;
  }
}

function friendlyError(err) {
  const reason = err?.reason;
  const where = err?.file ? ` in "${err.file.split("/").pop()}"` : "";
  if (reason === "ERAR_MISSING_PASSWORD" || reason === "ERAR_BAD_PASSWORD") {
    return "This .rar is password-protected, which isn't supported yet.";
  }
  if (reason === "ERAR_BAD_DATA" || reason === "ERAR_BAD_ARCHIVE") {
    return `Data error${where} (${reason}). The .rar may be damaged, incomplete, or only one part of a multi-part set.`;
  }
  if (reason === "ERAR_NO_MEMORY") {
    return "Ran out of memory while decompressing. Close other tabs and try again.";
  }
  const msg = err?.message || String(err);
  if (/OOM|out of memory|allocation failed/i.test(msg)) {
    return "Ran out of memory while decompressing. Close other tabs and try again.";
  }
  return reason ? `${msg} (${reason})` : msg;
}

let extractor = null;
let solid = false;
const sizes = new Map(); // name -> uncompressed size
const order = new Map(); // name -> position in archive order (files only)

// Pulls one file out. Non-solid archives can seek straight to it. Solid
// archives (every file is compressed using the ones before it) have to decode
// everything up to the target in order — earlier output is thrown away as it
// goes, only the target is kept.
function extractTarget(name, sequential, onProgress) {
  const ex = extractor;
  ex.done = null;
  ex.processed = 0;
  ex.onProgress = onProgress;
  let opts;
  if (sequential) {
    const idx = order.get(name);
    let total = 0;
    for (const [n, i] of order) if (i <= idx) total += sizes.get(n) || 0;
    ex.total = total;
    ex.keepFn = (n) => n === name;
    opts = { files: (h) => (order.get(h.name) ?? Infinity) <= idx };
  } else {
    ex.total = sizes.get(name) || 0;
    ex.keepFn = null;
    opts = { files: [name] };
  }
  try {
    const { files } = ex.extract(opts);
    for (const f of files) {
      if (f.fileHeader.name === name) break; // got it — no need to decode the rest
    }
  } finally {
    if (ex._archive) ex.closeArc();
    ex.onProgress = null;
    ex.keepFn = null;
  }
  if (!ex.done?.blob || ex.done.name !== name) throw new Error("That file couldn't be extracted.");
  const blob = ex.done.blob;
  ex.done = null;
  return blob;
}

self.onmessage = async ({ data: msg }) => {
  const { id } = msg;
  const progress = (frac) => self.postMessage({ type: "progress", id, frac });
  try {
    if (msg.type === "open") {
      const wasmBinary = await (await fetch(unrarWasmUrl)).arrayBuffer();
      const unrar = await getUnrar({ wasmBinary });
      extractor = new BlobExtractor(unrar, msg.file);
      unrar.extractor = extractor;
      const { arcHeader, fileHeaders } = extractor.getFileList();
      const entries = [];
      let anySolidFile = false;
      sizes.clear();
      order.clear();
      for (const h of fileHeaders) {
        if (h.flags.solid) anySolidFile = true;
        if (h.flags.directory) continue;
        order.set(h.name, order.size);
        sizes.set(h.name, h.unpSize);
        entries.push({ name: h.name, size: h.unpSize });
      }
      solid = !!arcHeader.flags.solid || anySolidFile;
      entries.sort((a, b) => a.name.localeCompare(b.name));
      self.postMessage({ type: "opened", id, entries, solid });
    } else if (msg.type === "extractOne") {
      // Non-solid: try the fast direct seek first, fall back to decoding in
      // order if that hits a data error. Solid: decode in order straight away.
      const modes = solid || msg.forceSequential ? [true] : [false, true];
      let blob = null;
      let lastErr = null;
      for (const sequential of modes) {
        try {
          blob = extractTarget(msg.name, sequential, progress);
          break;
        } catch (err) {
          lastErr = err;
          if (err?.reason !== "ERAR_BAD_DATA") break;
        }
      }
      if (!blob) throw lastErr || new Error("That file couldn't be extracted.");
      self.postMessage({ type: "done", id, blob });
    } else if (msg.type === "extractAll") {
      // One pass over the whole archive — the right call for solid RARs.
      let total = 0;
      for (const s of sizes.values()) total += s;
      extractor.done = null;
      extractor.processed = 0;
      extractor.total = total;
      extractor.keepFn = null;
      extractor.onProgress = progress;
      try {
        const { files } = extractor.extract();
        for (const f of files) {
          if (f.fileHeader.flags.directory) continue;
          const out = extractor.done;
          extractor.done = null;
          self.postMessage({ type: "file", id, name: f.fileHeader.name, blob: out?.blob || new Blob([]) });
        }
      } finally {
        if (extractor._archive) extractor.closeArc();
        extractor.onProgress = null;
      }
      self.postMessage({ type: "done", id });
    }
  } catch (err) {
    self.postMessage({ type: "error", id, message: friendlyError(err) });
  }
};
