// Pure parsing of `ffmpeg -i <file>` output into a readable media report:
// container, length, file size, per-video-stream frame rate / resolution /
// bitrate, a bits-per-pixel quality estimate, and audio/subtitle stream info.
// Kept free of ffmpeg imports so it can be unit-tested on plain log text.

import { languageName } from "./languages";

// Language name for a code: "Portuguese" for "por" or "pt-BR" (region codes
// fall back to the base language). Unknown codes are returned as they are.
function languageNameFor(code) {
  const full = languageName(code);
  if (full !== code || !code.includes("-")) return full;
  const base = languageName(code.split("-")[0]);
  return base !== code.split("-")[0] ? base : code;
}

// Label for a track: "Language (Track name) {code}", e.g. "Spanish (Spain) {es-es}".
// The track name part is left out when the file has none; the code in braces
// is left out when there is no language tag. "und" is shown as Unknown.
export function formatTrackLanguage(code, title) {
  const hasCode = !!code && code.toLowerCase() !== "und";
  const name = hasCode ? languageNameFor(code) : "Unknown";
  const namePart = title ? `${name} (${title})` : name;
  if (!hasCode) return namePart;
  return `${namePart} {${code}}`;
}

// Track names (the MKV "Name" / ffmpeg "title" tag) per stream index. ffmpeg
// prints each stream's metadata indented under its "Stream #0:N" line; a
// Chapter line ends that stream's block so chapter titles are not mixed in.
function extractStreamTitles(log) {
  const titles = new Map();
  let current = null;
  for (const line of log.split("\n")) {
    const streamMatch = line.match(/Stream #0:(\d+)/);
    if (streamMatch) {
      current = Number(streamMatch[1]);
      continue;
    }
    if (/^\s*Chapter #/.test(line) || /^Input #/.test(line)) {
      current = null;
      continue;
    }
    const titleMatch = line.match(/^\s{4,}title\s*:\s*(.+?)\s*$/);
    if (titleMatch && current !== null && !titles.has(current)) {
      titles.set(current, titleMatch[1]);
    }
  }
  return titles;
}

// Rough efficiency of each codec relative to H.264. A bits-per-pixel value
// means more quality from newer codecs, so it is scaled up before rating.
const CODEC_EFFICIENCY = {
  h264: 1.0,
  avc: 1.0,
  hevc: 1.6,
  h265: 1.6,
  vp9: 1.5,
  av1: 1.9,
  vp8: 0.8,
  mpeg4: 0.7,
  mpeg2video: 0.5,
};

function parseDurationSeconds(text) {
  const m = text.match(/(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Name a frame size by its height (the usual way video is labelled):
 * 480p, 720p, 1080p, 2K (1440p), 4K (2160p), 8K (4320p). Widths are used as
 * a fallback for odd heights, e.g. DCI 2K (2048 px wide).
 */
export function resolutionClass(width, height) {
  if (!width || !height) return null;
  // Letterboxed film (e.g. 1920x800 cinemascope) is still a 1080p frame, so
  // also consider the height a 16:9 frame of this width would have.
  const h = Math.max(height, Math.round((width * 9) / 16));
  if (h >= 4320) return "8K";
  if (h >= 2160) return "4K";
  if (h >= 1440 || width >= 2048) return "2K";
  if (h >= 1080) return "1080p (Full HD)";
  if (h >= 720) return "720p (HD)";
  if (h >= 480) return "480p (SD)";
  return `${h}p (below SD)`;
}

export function formatDuration(seconds) {

  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// Turn bits-per-pixel-per-frame (already codec-adjusted) into a verdict.
export function rateQuality(adjustedBpp) {
  if (adjustedBpp >= 0.12) {
    return { label: "Excellent", note: "Very little compression damage expected; detail and motion should look clean." };
  }
  if (adjustedBpp >= 0.07) {
    return { label: "Good", note: "Solid quality for normal viewing; fine detail may soften in fast motion." };
  }
  if (adjustedBpp >= 0.035) {
    return { label: "Fair", note: "Visible compression in dark scenes and fast motion; okay for casual watching." };
  }
  return { label: "Poor", note: "Heavy compression: blocky or smeared frames likely, especially in motion." };
}

function parseVideoStream(index, language, rest, containerBitrateKbps) {
  const codecMatch = rest.match(/^([A-Za-z0-9_]+)/);
  const codec = codecMatch ? codecMatch[1].toLowerCase() : "unknown";
  const profileMatch = rest.match(/^[A-Za-z0-9_]+ \(([^)]*)\)/);
  const profile = profileMatch && !/^[a-z0-9]+ \/|avc1|hvc1/i.test(profileMatch[1]) ? profileMatch[1] : null;

  const resMatch = rest.match(/\b(\d{3,5})x(\d{3,5})\b/);
  const width = resMatch ? Number(resMatch[1]) : null;
  const height = resMatch ? Number(resMatch[2]) : null;

  const fpsMatch = rest.match(/([\d.]+) fps/) || rest.match(/([\d.]+) tbr/);
  const fps = fpsMatch ? Number(fpsMatch[1]) : null;

  const pixMatch = rest.match(/\b(yuv[a-z0-9]+|rgba?|gray\w*|nv12|p010\w*)\b/i);
  const pixelFormat = pixMatch ? pixMatch[1] : null;

  const hdr = /bt2020|smpte2084|arib-std-b67/i.test(rest);

  // Stream-level bitrate is often missing in MKV; fall back to the container
  // total (minus audio, handled by the caller) and mark it as an estimate.
  const brMatch = rest.match(/(\d+) kb\/s/);
  let bitrateKbps = brMatch ? Number(brMatch[1]) : null;
  let bitrateEstimated = false;
  if (bitrateKbps === null && containerBitrateKbps) {
    bitrateKbps = containerBitrateKbps;
    bitrateEstimated = true;
  }

  let bpp = null;
  let quality = null;
  if (width && height && fps && bitrateKbps) {
    bpp = (bitrateKbps * 1000) / (width * height * fps);
    const factor = CODEC_EFFICIENCY[codec] ?? 1.0;
    quality = { ...rateQuality(bpp * factor), bitsPerPixel: bpp };
  }

  return {
    index,
    language,
    codec,
    profile,
    width,
    height,
    fps,
    pixelFormat,
    hdr,
    bitrateKbps,
    bitrateEstimated,
    quality,
  };
}

// Friendly names for common subtitle codecs (ffmpeg's internal names are
// hard to read: "subrip", "hdmv_pgs_subtitle", ...).
const SUBTITLE_NAMES = {
  subrip: "SRT",
  ass: "ASS",
  ssa: "SSA",
  webvtt: "WebVTT",
  mov_text: "MP4 text",
  hdmv_pgs_subtitle: "PGS (Blu-ray)",
  dvd_subtitle: "VobSub (DVD)",
  dvb_subtitle: "DVB",
};

function parseSubtitleStream(index, language, rest) {

  const codecMatch = rest.match(/^([A-Za-z0-9_]+)/);
  const flags = [];
  if (/\(default\)/.test(rest)) flags.push("default");
  if (/\(forced\)/.test(rest)) flags.push("forced");
  if (/\(hearing impaired\)|\(sdh\)/i.test(rest)) flags.push("SDH");
  return {
    index,
    language,
    codec: codecMatch ? (SUBTITLE_NAMES[codecMatch[1].toLowerCase()] || codecMatch[1].toLowerCase()) : "unknown",
    flags,
  };
}

function parseAudioStream(index, language, rest) {

  const codecMatch = rest.match(/^([A-Za-z0-9_]+)/);
  const sampleMatch = rest.match(/(\d+) Hz, ([^,]+),/);
  const brMatch = rest.match(/(\d+) kb\/s/);
  return {
    index,
    language,
    codec: codecMatch ? codecMatch[1].toLowerCase() : "unknown",
    sampleRate: sampleMatch ? Number(sampleMatch[1]) : null,
    channels: sampleMatch ? sampleMatch[2].trim() : null,
    bitrateKbps: brMatch ? Number(brMatch[1]) : null,
  };
}

/**
 * @param {string} log   text printed by `ffmpeg -i <file>` (stderr)
 * @param {number} sizeBytes  size of the source file
 * @param {string} fileName
 */
export function parseMediaInfo(log, sizeBytes, fileName, options = {}) {
  // Full BCP-47 codes (e.g. pt-BR) read from the container, keyed by stream
  // index. They win over the ISO code ffmpeg prints (e.g. por).
  const ietf = options.languageByIndex || new Map();
  // Container list is comma-separated (e.g. "mov,mp4,m4a,3gp,3g2,mj2"), so take the whole text before ", from".
  const inputMatch = log.match(/Input #0, (.+?), from /);
  const container = inputMatch ? inputMatch[1].trim() : "unknown";

  const durMatch = log.match(/Duration: ([^\n]+)/);
  const durationText = durMatch ? durMatch[1] : "";
  const durationSeconds = durMatch ? parseDurationSeconds(durMatch[1]) : null;
  const overallMatch = durationText.match(/bitrate: (\d+) kb\/s/);
  const overallBitrateKbps = overallMatch ? Number(overallMatch[1]) : null;

  const streamRegex = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?: (Video|Audio|Subtitle|Attachment|Data): ([^\n]*)/g;
  const streams = [];
  let m;
  while ((m = streamRegex.exec(log)) !== null) {
    streams.push({
      index: Number(m[1]),
      language: m[2] || null,
      kind: m[3],
      rest: m[4].trim(),
    });
  }

  const titles = extractStreamTitles(log);
  const audio = streams
    .filter((s) => s.kind === "Audio")
    .map((s) => {
      const title = titles.get(s.index) || null;
      const lang = ietf.get(s.index) || s.language;
      return { ...parseAudioStream(s.index, lang, s.rest), title, languageText: formatTrackLanguage(lang, title) };
    });
  const audioKbps = audio.reduce((sum, a) => sum + (a.bitrateKbps || 0), 0);
  // Video bitrate fallback: container total minus known audio bitrate.
  const videoFallbackKbps =
    overallBitrateKbps && overallBitrateKbps > audioKbps ? overallBitrateKbps - audioKbps : null;

  const video = streams
    .filter((s) => s.kind === "Video")
    .map((s) => parseVideoStream(s.index, s.language, s.rest, videoFallbackKbps));

  const subtitleTracks = streams
    .filter((s) => s.kind === "Subtitle")
    .map((s) => {
      const title = titles.get(s.index) || null;
      const lang = ietf.get(s.index) || s.language;
      return { ...parseSubtitleStream(s.index, lang, s.rest), title, languageText: formatTrackLanguage(lang, title) };
    });

  return {
    fileName,
    size: sizeBytes,
    sizeText: formatSize(sizeBytes),
    container,
    durationSeconds,
    durationText: formatDuration(durationSeconds),
    overallBitrateKbps,
    video,
    audio,
    subtitles: subtitleTracks.length,
    subtitleTracks,
    hasVideo: video.length > 0,
  };
}

/** Plain-text report: simple "Label: value" lines. Each file is numbered and
 * keeps all of its details together; the comparison (several files) comes last. */
export function reportToText(reports) {
  const lines = [];
  const many = reports.length > 1;

  reports.forEach((r, idx) => {
    const head = `File ${idx + 1}: ${r.fileName}`;
    // Double line above and below the file name only; other lines stay plain.
    lines.push("=".repeat(head.length), head, "=".repeat(head.length));
    lines.push(`Size: ${r.sizeText}`);
    lines.push(`Length: ${r.durationText}`);
    lines.push(`Container: ${r.container}`);
    if (r.overallBitrateKbps) lines.push(`Overall bitrate: ${r.overallBitrateKbps} kb/s`);
    r.video.forEach((v, i) => {
      lines.push(`Video ${i + 1}: ${v.codec}${v.profile ? ` (${v.profile})` : ""}`);
      if (v.width && v.height) lines.push(`  Resolution: ${v.width}x${v.height} (${resolutionClass(v.width, v.height)})`);
      if (v.fps) lines.push(`  Frame rate: ${v.fps} fps`);
      if (v.bitrateKbps) lines.push(`  Video bitrate: ${v.bitrateKbps} kb/s${v.bitrateEstimated ? " (estimated)" : ""}`);
      if (v.quality) lines.push(`  Quality: ${v.quality.label} - ${v.quality.note}`);
      if (v.hdr) lines.push("  HDR: yes");
    });
    r.audio.forEach((a, i) => {
      lines.push(
        `Audio ${i + 1}: ${a.codec} - ${a.languageText}` +
          `${a.channels ? `, ${a.channels}` : ""}${a.sampleRate ? `, ${a.sampleRate} Hz` : ""}` +
          `${a.bitrateKbps ? `, ${a.bitrateKbps} kb/s` : ""}`
      );
    });
    lines.push(`Subtitle tracks: ${r.subtitleTracks.length}`);
    r.subtitleTracks.forEach((s, i) => {
      lines.push(`Subtitle ${i + 1}: ${s.codec} - ${s.languageText}${s.flags.length ? ` (${s.flags.join(", ")})` : ""}`);
    });
    lines.push("");
  });

  if (many) {
    lines.push("Comparison:");
    reports.forEach((r, i) => {
      const v = r.video[0];
      lines.push(`  ${i + 1}. ${r.fileName}`);
      lines.push(`     Length: ${r.durationText}`);
      lines.push(`     Size: ${r.sizeText}`);
      lines.push(`     Resolution: ${v && v.width && v.height ? `${v.width}x${v.height}` : "-"}`);
      lines.push(`     Frame rate: ${v && v.fps ? `${v.fps} fps` : "-"}`);
      lines.push(`     Video bitrate: ${v && v.bitrateKbps ? `${v.bitrateKbps} kb/s` : "-"}`);
      lines.push(`     Quality: ${v && v.quality ? v.quality.label : "-"}`);
      lines.push("");
    });
  }
  return lines.join("\n");
}
