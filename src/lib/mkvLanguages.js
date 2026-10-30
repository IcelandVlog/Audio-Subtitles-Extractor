// Reads the full BCP-47 language code ("pt-BR", "zh-Hans") of each track from
// a Matroska/WebM file's Tracks header. ffmpeg's log only shows the ISO 639-2
// code ("por", "chi"); the exact code is stored in the LanguageIETF element.
// Only header bytes are read (via File.slice), so large files stay cheap.

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const CLUSTER = 0x1f43b675;
const TRACK_ENTRY = 0xae;
const LANGUAGE = 0x22b59c;
const LANGUAGE_IETF = 0x22b59d;

async function bytesAt(file, pos, len) {
  return new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
}

// Element ID keeps its length-marker bits, so it is read as-is.
async function readId(file, pos) {
  const first = (await bytesAt(file, pos, 1))[0];
  if (!first) return null;
  const len = Math.clz32(first) - 23;
  const bytes = await bytesAt(file, pos, len);
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + bytes[i];
  return { value, next: pos + len };
}

// Element size: the length-marker bit is removed; all value bits set = unknown.
async function readSize(file, pos) {
  const first = (await bytesAt(file, pos, 1))[0];
  if (!first) return null;
  const len = Math.clz32(first) - 23;
  const bytes = await bytesAt(file, pos, len);
  let value = bytes[0] & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + bytes[i];
  const bits = 7 * len;
  const unknown = value === 2 ** bits - 1;
  return { value, unknown, next: pos + len };
}

async function readElement(file, pos) {
  const id = await readId(file, pos);
  if (!id) return null;
  const size = await readSize(file, id.next);
  if (!size) return null;
  const start = size.next;
  return {
    id: id.value,
    size: size.value,
    unknown: size.unknown,
    start,
    end: size.unknown ? file.size : start + size.value,
  };
}

function text(bytes) {
  return new TextDecoder().decode(bytes).replace(/\0+$/, "").trim();
}

async function parseTrackEntry(file, start, end) {
  const fields = {};
  let pos = start;
  while (pos < end) {
    const el = await readElement(file, pos);
    if (!el || el.unknown) break;
    if (el.id === LANGUAGE_IETF || el.id === LANGUAGE) {
      const data = await bytesAt(file, el.start, el.size);
      if (el.id === LANGUAGE_IETF) fields.ietf = text(data);
      else fields.iso = text(data);
    }
    pos = el.end;
  }
  return fields;
}

/**
 * Map of stream index -> BCP-47 language code, for the tracks that have one.
 * Stream index is the track's position in the Tracks list, which is how
 * ffmpeg numbers the streams of a Matroska file. Empty for other containers.
 */
export async function readMkvLanguages(file) {
  const out = new Map();
  if (file.size < 8) return out;
  const magic = await bytesAt(file, 0, 4);
  if (!EBML_MAGIC.every((b, i) => magic[i] === b)) return out;

  const ebml = await readElement(file, 0);
  if (!ebml || ebml.unknown) return out;
  const segment = await readElement(file, ebml.end);
  if (!segment || segment.id !== SEGMENT) return out;

  const segEnd = Math.min(segment.end, file.size);
  let pos = segment.start;
  while (pos < segEnd) {
    const el = await readElement(file, pos);
    if (!el || el.unknown) break;
    if (el.id === CLUSTER) break; // Tracks comes before the first cluster
    if (el.id === TRACKS) {
      const tracksEnd = Math.min(el.end, file.size);
      let tpos = el.start;
      let index = 0;
      while (tpos < tracksEnd) {
        const entry = await readElement(file, tpos);
        if (!entry || entry.unknown) break;
        if (entry.id === TRACK_ENTRY) {
          const fields = await parseTrackEntry(file, entry.start, Math.min(entry.end, file.size));
          if (fields.ietf) out.set(index, fields.ietf);
          index++;
        }
        tpos = entry.end;
      }
      break;
    }
    pos = el.end;
  }
  return out;
}
