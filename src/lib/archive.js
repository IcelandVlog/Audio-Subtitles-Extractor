import JSZip from "jszip";
import { createExtractorFromData } from "node-unrar-js";
// Vite turns this into a fetchable URL and copies the .wasm into the build —
// we load the bytes ourselves and hand them to the library so it never tries
// to fetch a relative "unrar.wasm" path itself (which breaks under bundling).
import unrarWasmUrl from "node-unrar-js/esm/js/unrar.wasm?url";

let wasmBinaryPromise = null;
function loadUnrarWasm() {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = fetch(unrarWasmUrl).then((r) => r.arrayBuffer());
  }
  return wasmBinaryPromise;
}

export function detectArchiveKind(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".rar")) return "rar";
  if (name.endsWith(".zip")) return "zip";
  return null;
}

function sniffArchiveKindFromBytes(head) {
  if (head[0] === 0x50 && head[1] === 0x4b) return "zip"; // "PK"
  if (head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21) return "rar"; // "Rar!"
  return null;
}

// Native streaming decompression — supported on every current desktop and
// mobile browser (Chrome/Edge/Firefox since 2023, Safari since 16.4). When a
// browser has this we never need to hold a whole archive (or even a whole
// extracted file) in memory: we decompress a byte range as it flows through.
const HAS_DECOMPRESSION_STREAM = typeof DecompressionStream !== "undefined";

// File System Access lets "extract all" write straight to a folder on disk,
// one file at a time, instead of building one big zip in browser memory —
// that's what makes bulk extraction genuinely unbounded in size. Desktop
// Chrome/Edge support it; Safari and mobile browsers currently don't, so
// those fall back to the in-memory zip-download path further down.
export const SUPPORTS_FOLDER_SAVE =
  typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

// ---------------------------------------------------------------------
// Small binary-reading helpers. All ZIP fields are little-endian.
// ---------------------------------------------------------------------
async function sliceBytes(file, start, end) {
  const s = Math.max(0, start);
  const e = Math.min(file.size, end);
  if (e <= s) return new Uint8Array(0);
  const buf = await file.slice(s, e).arrayBuffer();
  return new Uint8Array(buf);
}

function u16(view, off) {
  return view.getUint16(off, true);
}
function u32(view, off) {
  return view.getUint32(off, true);
}
function u64(view, off) {
  return Number(view.getBigUint64(off, true));
}

// Good-enough filename decode: UTF-8 when the entry says so (virtually every
// modern zip tool sets this), otherwise a plain byte-preserving fallback —
// exotic legacy code pages are rare enough not to be worth pulling in a
// whole charset table for.
function decodeName(bytes, isUtf8) {
  if (isUtf8) return new TextDecoder().decode(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
void SIG_EOCD; // signature kept for documentation of the byte pattern searched below

// The end-of-central-directory record sits at the very end of the file,
// preceded by an optional comment of up to 65535 bytes — so we only ever
// need to read that small tail, never the archive itself, to find it.
async function findEOCD(file) {
  const tailLen = Math.min(file.size, 22 + 65535);
  const tailStart = file.size - tailLen;
  const tail = await sliceBytes(file, tailStart, file.size);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      return { offsetInFile: tailStart + i, view: new DataView(tail.buffer, tail.byteOffset + i, 22) };
    }
  }
  throw new Error("This doesn't look like a valid ZIP file (no end-of-central-directory record found).");
}

// Reads just the central directory (the archive's file list) — a handful of
// small, targeted reads regardless of how large the archive itself is.
// Understands ZIP64, so multi-gigabyte archives list just as fast as small
// ones.
async function readCentralDirectory(file) {
  const { offsetInFile: eocdOffset, view: eocdView } = await findEOCD(file);
  let cdOffset = u32(eocdView, 16);
  let cdSize = u32(eocdView, 12);
  let totalEntries = u16(eocdView, 10);

  if (cdOffset === 0xffffffff || totalEntries === 0xffff) {
    const locStart = eocdOffset - 20;
    if (locStart >= 0) {
      const loc = await sliceBytes(file, locStart, eocdOffset);
      const locView = new DataView(loc.buffer, loc.byteOffset, loc.byteLength);
      if (u32(locView, 0) === SIG_EOCD64_LOCATOR) {
        const zip64Offset = u64(locView, 8);
        const rec = await sliceBytes(file, zip64Offset, zip64Offset + 56);
        const recView = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
        if (u32(recView, 0) === SIG_EOCD64) {
          totalEntries = u64(recView, 32);
          cdSize = u64(recView, 40);
          cdOffset = u64(recView, 48);
        }
      }
    }
  }

  const cd = await sliceBytes(file, cdOffset, cdOffset + cdSize);
  const cdView = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = [];
  let p = 0;
  while (p + 4 <= cd.length && u32(cdView, p) === SIG_CENTRAL) {
    const flags = u16(cdView, p + 8);
    const method = u16(cdView, p + 10);
    let compSize = u32(cdView, p + 20);
    let uncompSize = u32(cdView, p + 24);
    const nameLen = u16(cdView, p + 28);
    const extraLen = u16(cdView, p + 30);
    const commentLen = u16(cdView, p + 32);
    const externalAttrs = u32(cdView, p + 38);
    let localOffset = u32(cdView, p + 42);

    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    const name = decodeName(nameBytes, (flags & 0x800) !== 0);

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let ep = 0;
      while (ep + 4 <= extra.length) {
        const id = extra[ep] | (extra[ep + 1] << 8);
        const size = extra[ep + 2] | (extra[ep + 3] << 8);
        if (id === 0x0001) {
          const ev = new DataView(extra.buffer, extra.byteOffset + ep + 4, size);
          let off = 0;
          if (uncompSize === 0xffffffff) {
            uncompSize = u64(ev, off);
            off += 8;
          }
          if (compSize === 0xffffffff) {
            compSize = u64(ev, off);
            off += 8;
          }
          if (localOffset === 0xffffffff) {
            localOffset = u64(ev, off);
          }
          break;
        }
        ep += 4 + size;
      }
    }

    const isDir = name.endsWith("/") || ((externalAttrs >>> 16) & 0x4000) !== 0;
    if (!isDir) {
      entries.push({ name, size: uncompSize, compressedSize: compSize, method, localOffset });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

// The local header repeats some central-directory fields right before each
// entry's actual bytes, and its filename/extra-field lengths can differ
// slightly from the central directory's — so a tiny 30-byte read is needed
// to find exactly where the real data starts.
async function localDataRange(file, entry) {
  const head = await sliceBytes(file, entry.localOffset, entry.localOffset + 30);
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (u32(hv, 0) !== SIG_LOCAL) throw new Error(`Corrupt local file header for "${entry.name}".`);
  const nameLen = u16(hv, 26);
  const extraLen = u16(hv, 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  return { start, end: start + entry.compressedSize };
}

// Pulls one entry's bytes straight off disk via Blob.slice (which is free —
// it doesn't read anything until consumed) and, for compressed entries,
// decompresses through the browser's native streaming inflate. Peak memory
// for a stored entry is effectively zero; for a deflated entry it's bounded
// by that one entry's decompressed size, never the whole archive.
// Wraps a byte stream in a pass-through TransformStream that reports
// cumulative bytes read against the entry's known uncompressed size — this
// is how single-file extraction gets a live percentage instead of a spinner.
function withProgress(stream, total, onProgress) {
  if (!onProgress || !total) return stream;
  let read = 0;
  const tracker = new TransformStream({
    transform(chunk, controller) {
      read += chunk.byteLength;
      onProgress(Math.min(1, read / total));
      controller.enqueue(chunk);
    },
  });
  return stream.pipeThrough(tracker);
}

async function extractZipEntry(file, entry, onProgress) {
  const { start, end } = await localDataRange(file, entry);
  const slice = file.slice(start, end);
  if (entry.method === 0) {
    // stored — already the raw content, but still stream it through the
    // tracker when progress is requested so large stored entries report too
    if (!onProgress) return slice;
    return new Response(withProgress(slice.stream(), entry.size, onProgress)).blob();
  }
  if (entry.method !== 8) {
    throw new Error(`"${entry.name}" uses an unsupported compression method (${entry.method}).`);
  }
  const decompressed = slice.stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(withProgress(decompressed, entry.size, onProgress)).blob();
}

function runPool(count, concurrency, task) {
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const i = next++;
      await task(i);
    }
  };
  return Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
}

// ---- ZIP (streaming — no size limit, no full-file read) ----
async function openZipStreaming(file) {
  const entries = await readCentralDirectory(file);

  return {
    kind: "zip",
    sizeLimited: false,
    entries: entries.map((e) => ({ name: e.name, size: e.size })),
    async extractOne(name, onProgress) {
      const entry = entries.find((e) => e.name === name);
      if (!entry) throw new Error("That file isn't in the archive.");
      return extractZipEntry(file, entry, onProgress);
    },
    async extractAll(onProgress) {
      const out = new Array(entries.length);
      const failed = [];
      let done = 0;
      await runPool(entries.length, 6, async (i) => {
        try {
          out[i] = { name: entries[i].name, blob: await extractZipEntry(file, entries[i]) };
        } catch (err) {
          failed.push({ name: entries[i].name, error: err?.message || "Extraction failed." });
        }
        done++;
        onProgress?.(done / entries.length);
      });
      return { files: out.filter(Boolean), failed };
    },
    // Writes every entry straight to a chosen folder, one at a time — never
    // holds more than a handful of entries' worth of bytes in memory at
    // once, so this is the truly-unlimited path for bulk extraction.
    async extractAllToDirectory(dirHandle, onProgress) {
      const failed = [];
      let done = 0;
      await runPool(entries.length, 4, async (i) => {
        const entry = entries[i];
        try {
          const blob = await extractZipEntry(file, entry);
          await writeBlobToDirectory(dirHandle, entry.name, blob);
        } catch (err) {
          failed.push({ name: entry.name, error: err?.message || "Extraction failed." });
        }
        done++;
        onProgress?.(done / entries.length);
      });
      return { failed };
    },
  };
}

// ---- ZIP (legacy fallback — only used when DecompressionStream is missing,
// i.e. a genuinely outdated browser). Loads the whole file once, like before. ----
async function openZipLegacy(file) {
  const buffer = await readFileWithRetry(file);
  const zip = await JSZip.loadAsync(buffer);
  const entries = [];
  zip.forEach((relPath, entry) => {
    if (entry.dir) return;
    entries.push({ name: entry.name, size: entry._data ? entry._data.uncompressedSize : 0 });
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  return {
    kind: "zip",
    sizeLimited: true,
    entries,
    async extractOne(name, onProgress) {
      const entry = zip.file(name);
      if (!entry) throw new Error("That file isn't in the archive.");
      return entry.async("blob", onProgress ? (meta) => onProgress(meta.percent / 100) : undefined);
    },
    async extractAll(onProgress) {
      const names = entries.map((e) => e.name);
      const out = new Array(names.length);
      const failed = [];
      let done = 0;
      await runPool(names.length, 6, async (i) => {
        try {
          out[i] = { name: names[i], blob: await zip.file(names[i]).async("blob") };
        } catch (err) {
          failed.push({ name: names[i], error: err?.message || "Extraction failed." });
        }
        done++;
        onProgress?.(done / names.length);
      });
      return { files: out.filter(Boolean), failed };
    },
  };
}

// ---- RAR ----
// The RAR format (unlike ZIP) has no browser-friendly index-then-stream
// structure, and the only maintained in-browser unrar library needs the
// whole archive as one buffer to work at all — that's a real constraint of
// the format/library, not something we can stream around. We still make
// reading that buffer as reliable as possible (chunked, with fallbacks) and
// avoid ever also duplicating it into a second big in-memory zip when
// writing straight to a folder.
function readViaFileReader(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsArrayBuffer(file);
  });
}

async function readViaStream(file) {
  const reader = file.stream().getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

// Chunked streaming read first (most reliable for cloud-synced / network
// files, since it never asks the OS for the whole file in one call), then
// two other browser read paths as fallback, before giving up with a
// friendly explanation.
async function readFileWithRetry(file) {
  try {
    return await readViaStream(file);
  } catch (err) {
    if (err?.name !== "NotReadableError") throw err;
  }
  for (let i = 0; i < 2; i++) {
    try {
      return await file.arrayBuffer();
    } catch (err) {
      if (err?.name !== "NotReadableError") throw err;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  try {
    return await readViaFileReader(file);
  } catch {
    throw new Error(
      "The browser couldn't read this file — this usually happens with files still syncing from " +
        "OneDrive/Google Drive (not fully downloaded to this device yet), a file on a network drive, " +
        "or antivirus briefly locking it. Try again in a moment, or copy the file to a local folder first."
    );
  }
}

async function openRar(file) {
  const [data, wasmBinary] = await Promise.all([readFileWithRetry(file), loadUnrarWasm()]);
  const extractor = await createExtractorFromData({ data, wasmBinary });

  const { fileHeaders } = extractor.getFileList();
  const entries = [];
  for (const h of fileHeaders) {
    if (h.flags.directory) continue;
    entries.push({ name: h.name, size: h.unpSize });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  return {
    kind: "rar",
    sizeLimited: true, // bounded by available memory — a real RAR-format/library constraint
    entries,
    // node-unrar-js extracts synchronously with no byte-level callback, so
    // there's no real progress to report here — the UI falls back to a
    // spinner for .rar single-file extraction instead of a percentage.
    async extractOne(name) {
      const { files } = extractor.extract({ files: [name] });
      const first = [...files][0];
      if (!first?.extraction) throw new Error("That file couldn't be extracted.");
      return new Blob([first.extraction]);
    },
    async extractAll(onProgress) {
      const { files } = extractor.extract();
      const all = [...files].filter((f) => !f.fileHeader.flags.directory);
      const out = all.map((f, i) => {
        onProgress?.((i + 1) / all.length);
        return { name: f.fileHeader.name, blob: new Blob([f.extraction]) };
      });
      return { files: out, failed: [] };
    },
    // Extracts and writes one file at a time so decompressed output isn't
    // also duplicated into a second big in-memory structure — the input
    // buffer is still fully resident (library constraint above), but the
    // output no longer has to be.
    async extractAllToDirectory(dirHandle, onProgress) {
      const failed = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        try {
          const { files } = extractor.extract({ files: [entry.name] });
          const first = [...files][0];
          if (!first?.extraction) throw new Error("Extraction failed.");
          await writeBlobToDirectory(dirHandle, entry.name, new Blob([first.extraction]));
        } catch (err) {
          failed.push({ name: entry.name, error: err?.message || "Extraction failed." });
        }
        onProgress?.((i + 1) / entries.length);
      }
      return { failed };
    },
  };
}

async function writeBlobToDirectory(dirHandle, relPath, blob) {
  const parts = relPath.split("/").filter((p) => p && p !== ".." && p !== ".");
  const fileName = parts.pop();
  let dir = dirHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await blob.stream().pipeTo(writable);
}

/** Open a .zip or .rar file and return its entry list plus lazy extractors. */
export async function openArchive(file) {
  let kind = detectArchiveKind(file);
  if (!kind) {
    const head = await sliceBytes(file, 0, 8);
    kind = sniffArchiveKindFromBytes(head);
  }
  if (kind === "zip") return HAS_DECOMPRESSION_STREAM ? openZipStreaming(file) : openZipLegacy(file);
  if (kind === "rar") return openRar(file);
  throw new Error("Only .zip and .rar archives are supported.");
}
