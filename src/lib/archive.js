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

// Fallback for misnamed files — reads only the first few bytes, not the
// whole archive, so it's effectively instant.
async function sniffArchiveKind(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) return "zip"; // "PK"
  if (head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21) return "rar"; // "Rar!"
  return null;
}

// ---- ZIP ----
// JSZip.loadAsync only parses the central directory (the file list) up
// front — it does not inflate any file contents, so this is fast even for
// huge zips. Each entry is only decompressed when actually requested.
async function openZip(file) {
  const zip = await JSZip.loadAsync(file);
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
    async extractAll(onProgress) {
      const names = entries.map((e) => e.name);
      const out = [];
      for (let i = 0; i < names.length; i++) {
        const blob = await zip.file(names[i]).async("blob");
        out.push({ name: names[i], blob });
        onProgress?.((i + 1) / names.length);
      }
      return out;
    },
  };
}

// ---- RAR ----
// getFileList() only reads headers (fast, no decompression). Per-file
// extract() only decodes what's asked for; extractAll uses one unfiltered
// pass, which is the efficient path for solid archives.
async function openRar(file) {
  const [data, wasmBinary] = await Promise.all([file.arrayBuffer(), loadUnrarWasm()]);
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
  const kind = detectArchiveKind(file) || (await sniffArchiveKind(file));
  if (kind === "zip") return openZip(file);
  if (kind === "rar") return openRar(file);
  throw new Error("Only .zip and .rar archives are supported.");
}
