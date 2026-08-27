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

// Three different ways to pull bytes out of a File — browsers implement
// these through genuinely different internal code paths, so a file that a
// NotReadableError on one can sometimes still be read by another.
function readViaFileReader(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsArrayBuffer(file);
  });
}

async function readViaStream(file) {
  const stream = file.stream();
  const reader = stream.getReader();
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

// Reads the whole file into memory once, up front. Why this exists: the
// browser throws a generic "could not be read... after a reference to a file
// was acquired" (NotReadableError) when the underlying file handle goes
// stale between being picked and being read — most often because it's a
// cloud-sync placeholder (OneDrive/Google Drive "on demand") that hadn't
// finished downloading yet, or antivirus briefly locked it right after
// selection. We retry the normal path a few times first (clears most
// transient cases), then fall back to two other browser APIs that read the
// same File through different internal code — one of them frequently
// succeeds even when the first is stuck failing.
async function readFileWithRetry(file, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await file.arrayBuffer();
    } catch (err) {
      lastErr = err;
      if (err?.name !== "NotReadableError") break;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }

  if (lastErr?.name === "NotReadableError") {
    try {
      return await readViaFileReader(file);
    } catch {
      // fall through to the stream attempt below
    }
    try {
      return await readViaStream(file);
    } catch {
      // fall through to the friendly error below
    }
    throw new Error(
      "The browser couldn't read this file — this usually happens with files still syncing from " +
        "OneDrive/Google Drive (not fully downloaded to this device yet), a file on a network drive, " +
        "or antivirus briefly locking it. Try again in a moment, or copy the file to a local folder first."
    );
  }
  throw lastErr;
}

// ---- ZIP ----
// The central directory (file list) sits at the end of the file, so parsing
// it doesn't require inflating any entry — that only happens lazily when a
// specific entry is actually requested.
function openZip(buffer) {
  return JSZip.loadAsync(buffer).then((zip) => {
    const entries = [];
    zip.forEach((relPath, entry) => {
      if (entry.dir) return;
      entries.push({ name: entry.name, size: entry._data ? entry._data.uncompressedSize : 0 });
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    return {
      kind: "zip",
      entries,
      async extractOne(name) {
        const entry = zip.file(name);
        if (!entry) throw new Error("That file isn't in the archive.");
        return entry.async("blob");
      },
      // Runs extractions in parallel batches instead of one at a time —
      // inflate is CPU-bound per entry but the browser can juggle several
      // concurrently, which is noticeably faster for archives with many
      // small-to-medium files.
      async extractAll(onProgress) {
        const names = entries.map((e) => e.name);
        const out = new Array(names.length);
        let done = 0;
        const CONCURRENCY = 6;
        let next = 0;
        const worker = async () => {
          while (next < names.length) {
            const i = next++;
            out[i] = { name: names[i], blob: await zip.file(names[i]).async("blob") };
            done++;
            onProgress?.(done / names.length);
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker));
        return out;
      },
    };
  });
}

// ---- RAR ----
// getFileList() only reads headers (fast, no decompression). Per-file
// extract() only decodes what's asked for; extractAll uses one unfiltered
// pass, which is the efficient path for solid archives (unrar's own
// underlying pass is sequential regardless, so this isn't parallelized).
async function openRar(buffer) {
  const [data, wasmBinary] = await Promise.all([Promise.resolve(buffer), loadUnrarWasm()]);
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
    entries,
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
      return out;
    },
  };
}

/** Open a .zip or .rar file and return its entry list plus lazy extractors. */
export async function openArchive(file) {
  const buffer = await readFileWithRetry(file);
  const kind = detectArchiveKind(file) || sniffArchiveKindFromBytes(new Uint8Array(buffer, 0, 8));
  if (kind === "zip") return openZip(buffer);
  if (kind === "rar") return openRar(buffer);
  throw new Error("Only .zip and .rar archives are supported.");
}
