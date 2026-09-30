// Runs inside a Web Worker. Reads a .rar straight off disk in small blocks
// (via FileReaderSync, which is only allowed in workers) instead of loading
// the whole archive into one giant ArrayBuffer — that single allocation is
// what failed with "Array buffer allocation failed" on multi-GB archives.
//
// node-unrar-js talks to its wasm through a handful of *synchronous* file
// callbacks (open / read / seek / tell / create / write / close). We subclass
// its Extractor and answer them ourselves:
//   - reads come from the original File, 8 MB at a time
//   - writes are collected into Blobs (which the browser can keep on disk),
//     never one contiguous buffer
import { Extractor } from "node-unrar-js/esm/js/Extractor.js";
import { getUnrar } from "node-unrar-js/esm/js/unrar.singleton.js";
import unrarWasmUrl from "node-unrar-js/esm/js/unrar.wasm?url";

const SRC_FD = 1;
const READ_BLOCK = 8 * 1024 * 1024; // how much of the archive we pull per disk read
const BLOB_FLUSH = 32 * 1024 * 1024; // seal output into a Blob every ~32 MB

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
    this.current = null; // output currently being written
    this.done = null; // last finished output
    this.expected = 0;
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
    const out = { name: filename, parts: [], blobs: [], pending: 0, size: 0 };
    this.outs.set(fd, out);
    this.current = out;
    return fd;
  }

  closeFile(fd) {
    if (fd === SRC_FD) {
      this.srcPos = 0;
      return;
    }
    const out = this.outs.get(fd);
    if (!out) return;
    out.blob = new Blob([...out.blobs, ...out.parts]);
    out.parts = [];
    out.blobs = [];
    this.outs.delete(fd);
    this.done = out;
  }

  read(fd, buf, size) {
    if (fd !== SRC_FD) return -1;
    // Same contract as the library's own in-memory reader: a read that would
    // run past the end of the file fails with -1 (no partial data). unrar
    // relies on that — it asks for a large block at the tail of small
    // archives and treats a short read as corruption.
    const start = this.srcPos;
    if (size === 0) return 0;
    if (start + size > this.src.size) return -1;
    const end = start + size;
    const n = size;

    const cacheEnd = this.cache ? this.cacheStart + this.cache.byteLength : 0;
    if (!this.cache || start < this.cacheStart || end > cacheEnd) {
      const blockEnd = Math.min(this.src.size, start + Math.max(size, READ_BLOCK));
      this.cache = new Uint8Array(this.reader.readAsArrayBuffer(this.src.slice(start, blockEnd)));
      this.cacheStart = start;
    }
    const off = start - this.cacheStart;
    this.unrar.HEAPU8.set(this.cache.subarray(off, off + n), buf);
    this.srcPos = end;
    return n;
  }

  write(fd, buf, size) {
    const out = this.outs.get(fd);
    if (!out) return false;
    out.parts.push(this.unrar.HEAPU8.slice(buf, buf + size));
    out.pending += size;
    out.size += size;
    if (out.pending >= BLOB_FLUSH) {
      out.blobs.push(new Blob(out.parts));
      out.parts = [];
      out.pending = 0;
    }
    if (this.onProgress && this.expected) {
      const now = Date.now();
      if (now - this.lastProgressAt > 100) {
        this.lastProgressAt = now;
        this.onProgress(Math.min(1, out.size / this.expected));
      }
    }
    return true;
  }

  tell(fd) {
    return fd === SRC_FD ? this.srcPos : (this.outs.get(fd)?.size ?? -1);
  }

  seek(fd, pos, method) {
    if (fd !== SRC_FD) return true; // output is append-only
    let p = this.srcPos;
    if (method === "SET") p = pos;
    else if (method === "CUR") p = this.srcPos + pos;
    else p = this.src.size - pos; // "END": offset counted back from the end
    if (p < 0 || p > this.src.size) return false;
    this.srcPos = p;
    return true;
  }
}

function friendlyError(err) {
  const reason = err?.reason;
  if (reason === "ERAR_MISSING_PASSWORD" || reason === "ERAR_BAD_PASSWORD") {
    return "This .rar is password-protected, which isn't supported yet.";
  }
  if (reason === "ERAR_BAD_DATA" || reason === "ERAR_BAD_ARCHIVE") {
    return "This .rar looks damaged or is only one part of a multi-part archive.";
  }
  const msg = err?.message || String(err);
  if (/OOM|out of memory|allocation failed/i.test(msg)) {
    return "Ran out of memory while decompressing. Close other tabs and try again.";
  }
  return msg;
}

let extractor = null;
const sizes = new Map();

self.onmessage = async ({ data: msg }) => {
  const { id } = msg;
  try {
    if (msg.type === "open") {
      const wasmBinary = await (await fetch(unrarWasmUrl)).arrayBuffer();
      const unrar = await getUnrar({ wasmBinary });
      extractor = new BlobExtractor(unrar, msg.file);
      unrar.extractor = extractor;
      const { fileHeaders } = extractor.getFileList();
      const entries = [];
      for (const h of fileHeaders) {
        if (h.flags.directory) continue;
        entries.push({ name: h.name, size: h.unpSize });
        sizes.set(h.name, h.unpSize);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      self.postMessage({ type: "opened", id, entries });
    } else if (msg.type === "extractOne") {
      extractor.done = null;
      extractor.expected = sizes.get(msg.name) || 0;
      extractor.onProgress = (frac) => self.postMessage({ type: "progress", id, frac });
      const { files } = extractor.extract({ files: [msg.name] });
      for (const f of files) void f; // drain the generator — this is what does the work
      extractor.onProgress = null;
      if (!extractor.done) throw new Error("That file couldn't be extracted.");
      self.postMessage({ type: "done", id, blob: extractor.done.blob });
      extractor.done = null;
    } else if (msg.type === "extractAll") {
      // One pass over the archive: important for "solid" RARs, where pulling
      // files out one by one would re-decompress everything before each one.
      let total = sizes.size || 1;
      let count = 0;
      extractor.onProgress = null;
      const { files } = extractor.extract();
      for (const f of files) {
        if (f.fileHeader.flags.directory) continue;
        const out = extractor.done;
        extractor.done = null;
        count++;
        self.postMessage({
          type: "file",
          id,
          name: f.fileHeader.name,
          blob: out?.blob || new Blob([]),
          frac: Math.min(1, count / total),
        });
      }
      self.postMessage({ type: "done", id });
    }
  } catch (err) {
    self.postMessage({ type: "error", id, message: friendlyError(err) });
  }
};
