import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import {
  probeFile,
  extractSubtitle,
  cleanupInput,
  loadEngine,
  extractAudioNative,
  convertAudioFromNative,
  formatMatchesCodec,
  defaultFormatForCodec,
} from "./ffmpegEngine";
import { downloadBlob, stripExt } from "./download";
import { languageLabel } from "./languages";

let idCounter = 0;
const nextId = () => `track-${++idCounter}`;

// Groups every audio/subtitle stream across the whole queue by language code,
// for the "target languages" picker — one row per language with how many
// streams and how many distinct files carry it, so the user can see what
// they're about to pull before committing.
function buildLanguageOptions(tracks, kind) {
  const listKey = kind === "audio" ? "audioStreams" : "subtitleStreams";
  const byCode = new Map();
  for (const track of tracks) {
    const seenInThisFile = new Set();
    for (const stream of track[listKey]) {
      const code = stream.language || "und";
      if (!byCode.has(code)) {
        byCode.set(code, { code, label: languageLabel(code), streamCount: 0, fileCount: 0 });
      }
      const entry = byCode.get(code);
      entry.streamCount += 1;
      if (!seenInThisFile.has(code)) {
        entry.fileCount += 1;
        seenInThisFile.add(code);
      }
    }
  }
  return Array.from(byCode.values()).sort(
    (a, b) => b.streamCount - a.streamCount || a.label.localeCompare(b.label)
  );
}

const VIDEO_TYPES = /\.(mp4|mov|mkv|avi|flv|webm|m4v|wmv)$/i;

// Very large files roughly double their size in browser memory (original + wasm FS
// copy) and can exceed what the tab is allowed to hold. Warn rather than block.
const LARGE_FILE_WARNING_BYTES = 1.5 * 1024 * 1024 * 1024;

const ENGINE_LOAD_TIMEOUT_MS = 60_000;

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function makeAudioStream(s) {
  return {
    index: s.index,
    codec: s.codec,
    language: s.language,
    label: languageLabel(s.language),
    // Default to whatever format the source codec already is, so the first
    // Extract is pure stream-copy end to end (no slow re-encode step). The
    // user can still switch it — that just brings the convert step back.
    format: defaultFormatForCodec(s.codec),
    status: "idle", // idle | extracting | done | error
    progress: 0,
    result: null, // { extension, blob } once extracted — kept for Download
    native: null, // { blob, extension, codec } — original stream, copied not re-encoded; cached so switching format doesn't re-touch the source video
    error: null,
  };
}

function makeSubtitleStream(s) {
  return {
    index: s.index,
    codec: s.codec,
    language: s.language,
    label: languageLabel(s.language),
    status: "idle",
    progress: 0,
    result: null, // { extension, blob } once extracted — kept for Show/Download
    error: null,
  };
}

export function useTrackQueue() {
  const [tracks, setTracks] = useState([]);
  const [engineState, setEngineState] = useState("idle"); // idle | loading | ready | error
  const [engineError, setEngineError] = useState(null);
  const engineRequested = useRef(false);

  // ---- queue-level "all of a kind, across every file" state ----
  // Separate from each track's own audioAllStatus/subsAllStatus (extract all
  // streams of one kind within one file) — this is one level up: extract
  // that same kind across the whole queue and hand back a single zip.
  const [queueAudioAllStatus, setQueueAudioAllStatus] = useState("idle"); // idle | extracting | done | error
  const [queueAudioAllProgress, setQueueAudioAllProgress] = useState(0);
  const [queueAudioAllResult, setQueueAudioAllResult] = useState(null);
  const [queueSubsAllStatus, setQueueSubsAllStatus] = useState("idle");
  const [queueSubsAllProgress, setQueueSubsAllProgress] = useState(0);
  const [queueSubsAllResult, setQueueSubsAllResult] = useState(null);
  // tracks/streams are read inside async extraction flows, so keep a live ref
  // alongside the state to avoid closing over stale data across awaits.
  const tracksRef = useRef(tracks);
  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  const patchTrack = useCallback((id, patch) => {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // patch a single stream inside a track's audioStreams/subtitleStreams array
  const patchStream = useCallback((trackId, kind, streamIndex, patch) => {
    const listKey = kind === "audio" ? "audioStreams" : "subtitleStreams";
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        return {
          ...t,
          [listKey]: t[listKey].map((s) => (s.index === streamIndex ? { ...s, ...patch } : s)),
        };
      })
    );
  }, []);

  const ensureEngine = useCallback(async () => {
    if (engineRequested.current) return;
    engineRequested.current = true;
    setEngineState("loading");
    setEngineError(null);
    try {
      await withTimeout(
        loadEngine(),
        ENGINE_LOAD_TIMEOUT_MS,
        "Timed out loading the processing engine."
      );
      setEngineState("ready");
    } catch (err) {
      // allow the user to retry (e.g. after fixing their connection)
      engineRequested.current = false;
      setEngineState("error");
      console.error("[engine] load failed:", err);
      setEngineError(
        "Couldn't load the audio engine. Check your internet connection — this app downloads " +
          "an ffmpeg core (~30MB) from a CDN the first time — and try adding the file again."
      );
      throw err;
    }
  }, []);

  const addFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList).filter((f) => VIDEO_TYPES.test(f.name));
      if (files.length === 0) return;

      const newTracks = files.map((file) => ({
        id: nextId(),
        file,
        name: file.name,
        size: file.size,
        status: "queued", // queued | uploading | probing | ready | error
        uploadProgress: 0,
        duration: null,
        audioStreams: [],
        subtitleStreams: [],
        audioAllStatus: "idle", // idle | extracting | done | error
        audioAllProgress: 0,
        audioAllResult: null,
        subsAllStatus: "idle",
        subsAllProgress: 0,
        subsAllResult: null,
        error: null,
        warning:
          file.size > LARGE_FILE_WARNING_BYTES
            ? "Large file — this may be slow or run out of memory in some browsers."
            : null,
        inputName: null,
      }));

      setTracks((prev) => [...prev, ...newTracks]);
      // newly-added files aren't in any previously-built "all files" zip —
      // clear it so Download-all goes back to offering a fresh Extract.
      setQueueAudioAllStatus("idle");
      setQueueAudioAllProgress(0);
      setQueueAudioAllResult(null);
      setQueueSubsAllStatus("idle");
      setQueueSubsAllProgress(0);
      setQueueSubsAllResult(null);

      try {
        await ensureEngine();
      } catch {
        // engine failed to load: surface the error on every track we just queued
        // instead of leaving them stuck at "queued" forever.
        newTracks.forEach((t) =>
          patchTrack(t.id, {
            status: "error",
            error: "Engine failed to load. See the message above the upload box.",
          })
        );
        return;
      }

      // probe files one at a time — they all share the single ffmpeg instance
      for (const t of newTracks) {
        patchTrack(t.id, { status: "uploading", uploadProgress: 0 });
        try {
          const { inputName, streams, duration } = await probeFile(t.file, {
            onProgress: (p) => patchTrack(t.id, { uploadProgress: p }),
            onUploaded: () => patchTrack(t.id, { status: "probing" }),
          });
          const audioStreams = streams.filter((s) => s.type === "Audio").map(makeAudioStream);
          const subtitleStreams = streams.filter((s) => s.type === "Subtitle").map(makeSubtitleStream);
          patchTrack(t.id, {
            status: "ready",
            inputName,
            duration,
            audioStreams,
            subtitleStreams,
          });
        } catch (err) {
          console.error("[probe] failed:", err);
          const detail = err?.message ? `: ${err.message}` : "";
          patchTrack(t.id, { status: "error", error: `Couldn't read this file${detail}` });
        }
      }
    },
    [ensureEngine, patchTrack]
  );

  const setAudioFormat = useCallback(
    (trackId, streamIndex, format) => {
      const track = tracksRef.current.find((t) => t.id === trackId);
      const stream = track?.audioStreams.find((s) => s.index === streamIndex);
      const patch = { format };
      // a previous result was for the old format — drop it so Extract runs again.
      // `native` (the stream-copied original) is intentionally left alone: the
      // next Extract click converts from that cached copy instead of
      // re-reading the whole video.
      if (stream && (stream.status === "done" || stream.status === "error")) {
        patch.status = "idle";
        patch.progress = 0;
        patch.result = null;
        patch.error = null;
      }
      patchStream(trackId, "audio", streamIndex, patch);
    },
    [patchStream]
  );

  const removeTrack = useCallback((id) => {
    setTracks((prev) => {
      const t = prev.find((x) => x.id === id);
      if (t?.inputName) cleanupInput(t.inputName);
      return prev.filter((x) => x.id !== id);
    });
    // a queue-wide zip built earlier no longer reflects "every file" once one
    // is removed — clear it so the button goes back to Extract rather than
    // offering a stale Download.
    setQueueAudioAllStatus("idle");
    setQueueAudioAllProgress(0);
    setQueueAudioAllResult(null);
    setQueueSubsAllStatus("idle");
    setQueueSubsAllProgress(0);
    setQueueSubsAllResult(null);
  }, []);

  // ---- single-stream extraction ----
  // Neither kind auto-downloads anymore: the blob is kept on the stream's result
  // so a separate Download click can use it afterwards.
  const extractOneStream = useCallback(
    async (trackId, kind, streamIndex) => {
      const track = tracksRef.current.find((t) => t.id === trackId);
      if (!track) return null;
      const list = kind === "audio" ? track.audioStreams : track.subtitleStreams;
      const stream = list.find((s) => s.index === streamIndex);
      if (!stream || stream.status === "extracting") return null;

      patchStream(trackId, kind, streamIndex, { status: "extracting", progress: 0, error: null });
      try {
        if (kind === "audio") {
          // Step 1: get the original track via stream copy (no re-encode) —
          // fast regardless of video length. Cached so a later format switch
          // reuses it instead of re-touching the source video.
          let native = stream.native;
          if (!native) {
            native = await extractAudioNative({
              inputName: track.inputName,
              streamIndex,
              codec: stream.codec,
              onProgress: (p) => patchStream(trackId, kind, streamIndex, { progress: p * 0.6 }),
            });
            patchStream(trackId, kind, streamIndex, { native });
          }

          // Step 2: only re-process (convert) if the requested format isn't
          // already what the native track is — and only from the small
          // extracted track, not the whole video.
          const blob = formatMatchesCodec(stream.format, native.codec)
            ? native.blob
            : await convertAudioFromNative({
                nativeBlob: native.blob,
                nativeExtension: native.extension,
                streamIndex,
                format: stream.format,
                onProgress: (p) => patchStream(trackId, kind, streamIndex, { progress: 0.6 + p * 0.4 }),
              });

          patchStream(trackId, kind, streamIndex, {
            status: "done",
            progress: 1,
            result: { extension: stream.format, blob },
          });
          return { blob, extension: stream.format };
        } else {
          const { blob, extension } = await extractSubtitle({
            inputName: track.inputName,
            streamIndex,
            codec: stream.codec,
            onProgress: (p) => patchStream(trackId, kind, streamIndex, { progress: p }),
          });
          patchStream(trackId, kind, streamIndex, {
            status: "done",
            progress: 1,
            result: { extension, blob },
          });
          return { blob, extension };
        }
      } catch {
        patchStream(trackId, kind, streamIndex, { status: "error", error: "Extraction failed." });
        return null;
      }
    },
    [patchStream]
  );

  const extractOneAudio = useCallback(
    (trackId, streamIndex) => extractOneStream(trackId, "audio", streamIndex),
    [extractOneStream]
  );
  const extractOneSubtitle = useCallback(
    (trackId, streamIndex) => extractOneStream(trackId, "subtitle", streamIndex),
    [extractOneStream]
  );

  // "Download": just saves the already-extracted blob, no re-extraction.
  const downloadOneAudio = useCallback((trackId, streamIndex) => {
    const track = tracksRef.current.find((t) => t.id === trackId);
    const stream = track?.audioStreams.find((s) => s.index === streamIndex);
    if (!stream?.result?.blob) return;
    const base = stripExt(track.name);
    const langTag = stream.language && stream.language !== "und" ? `.${stream.language}` : "";
    downloadBlob(stream.result.blob, `${base}${langTag}.${stream.result.extension}`);
  }, []);

  const downloadOneSubtitle = useCallback((trackId, streamIndex) => {
    const track = tracksRef.current.find((t) => t.id === trackId);
    const stream = track?.subtitleStreams.find((s) => s.index === streamIndex);
    if (!stream?.result?.blob) return;
    const base = stripExt(track.name);
    const langTag = stream.language && stream.language !== "und" ? `.${stream.language}` : "";
    downloadBlob(stream.result.blob, `${base}${langTag}.${stream.result.extension}`);
  }, []);

  // ---- "extract all" for one kind on one video: zips every stream of that kind ----
  const extractAllOfKind = useCallback(
    async (trackId, kind) => {
      const track = tracksRef.current.find((t) => t.id === trackId);
      if (!track) return;
      const list = kind === "audio" ? track.audioStreams : track.subtitleStreams;
      if (list.length === 0) return;

      const statusKey = kind === "audio" ? "audioAllStatus" : "subsAllStatus";
      const progressKey = kind === "audio" ? "audioAllProgress" : "subsAllProgress";
      patchTrack(trackId, { [statusKey]: "extracting", [progressKey]: 0 });

      const base = stripExt(track.name);
      const zip = new JSZip();
      const perStreamProgress = new Array(list.length).fill(0);
      const usedNames = new Set();

      const reportOverall = () => {
        const avg = perStreamProgress.reduce((a, b) => a + b, 0) / perStreamProgress.length;
        patchTrack(trackId, { [progressKey]: avg });
      };

      const uniqueName = (name) => {
        if (!usedNames.has(name)) {
          usedNames.add(name);
          return name;
        }
        const dot = name.lastIndexOf(".");
        let n = 2;
        let candidate;
        do {
          candidate = `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
          n++;
        } while (usedNames.has(candidate));
        usedNames.add(candidate);
        return candidate;
      };

      try {
        // Streams are extracted one at a time (own ffmpeg pass each), not
        // batched into a single multi-map command, so progress reflects the
        // stream actually being worked on and one bad stream can't abort the
        // rest of the set. Only the stream currently being processed is
        // marked "extracting" (right before its own turn) — the rest stay
        // "idle" and their row stays disabled via the track's overall
        // audioAllStatus/subsAllStatus ("extracting") until this loop ends,
        // so the UI shows a single live percentage instead of every row
        // sitting at 0%.
        for (let i = 0; i < list.length; i++) {
          const stream = list[i];
          const langTag = stream.language && stream.language !== "und" ? `.${stream.language}` : "";
          patchStream(trackId, kind, stream.index, { status: "extracting", progress: 0, error: null });
          try {
            if (kind === "audio") {
              let native = stream.native;
              if (!native) {
                native = await extractAudioNative({
                  inputName: track.inputName,
                  streamIndex: stream.index,
                  codec: stream.codec,
                  onProgress: (p) => {
                    perStreamProgress[i] = p * 0.6;
                    reportOverall();
                    patchStream(trackId, kind, stream.index, { progress: p * 0.6 });
                  },
                });
                patchStream(trackId, kind, stream.index, { native });
              }
              const blob = formatMatchesCodec(stream.format, native.codec)
                ? native.blob
                : await convertAudioFromNative({
                    nativeBlob: native.blob,
                    nativeExtension: native.extension,
                    streamIndex: stream.index,
                    format: stream.format,
                    onProgress: (p) => {
                      const overall = 0.6 + p * 0.4;
                      perStreamProgress[i] = overall;
                      reportOverall();
                      patchStream(trackId, kind, stream.index, { progress: overall });
                    },
                  });
              zip.file(uniqueName(`${base}${langTag}.${stream.format}`), blob);
              patchStream(trackId, kind, stream.index, {
                status: "done",
                progress: 1,
                result: { extension: stream.format, blob },
              });
            } else {
              const { blob, extension } = await extractSubtitle({
                inputName: track.inputName,
                streamIndex: stream.index,
                codec: stream.codec,
                onProgress: (p) => {
                  perStreamProgress[i] = p;
                  reportOverall();
                  patchStream(trackId, kind, stream.index, { progress: p });
                },
              });
              zip.file(uniqueName(`${base}${langTag}.${extension}`), blob);
              patchStream(trackId, kind, stream.index, {
                status: "done",
                progress: 1,
                result: { extension, blob },
              });
            }
          } catch (streamErr) {
            console.error(`[extractAll:${kind}] stream ${stream.index} failed:`, streamErr);
            patchStream(trackId, kind, stream.index, { status: "error", error: "Extraction failed." });
          }
          perStreamProgress[i] = 1;
          reportOverall();
        }

        // STORE: these are already-encoded audio/subtitle blobs, so skip DEFLATE.
        const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
        const resultKey = kind === "audio" ? "audioAllResult" : "subsAllResult";
        patchTrack(trackId, { [statusKey]: "done", [progressKey]: 1, [resultKey]: zipBlob });
      } catch (err) {
        console.error(`[extractAll:${kind}] failed:`, err);
        patchTrack(trackId, { [statusKey]: "error", [progressKey]: 0 });
      }
    },
    [patchTrack, patchStream]
  );

  const extractAllAudio = useCallback((trackId) => extractAllOfKind(trackId, "audio"), [extractAllOfKind]);
  const extractAllSubtitles = useCallback(
    (trackId) => extractAllOfKind(trackId, "subtitle"),
    [extractAllOfKind]
  );

  // ---- queue-level: bundle whatever the user has already pulled out one at a
  // time, across every file in the queue, into a single zip. This does NOT
  // extract anything new — it only collects streams of one kind (audio or
  // subtitle) that are already status "done" from a manual per-track Extract
  // click, and zips those together. If someone has extracted 3 audio tracks
  // out of 10 files, clicking "Bundle extracted" zips exactly those 3.
  const bundleExtractedOfKindForQueue = useCallback(
    async (kind) => {
      const tracksNow = tracksRef.current;
      const extractedEntries = [];
      for (const track of tracksNow) {
        const list = kind === "audio" ? track.audioStreams : track.subtitleStreams;
        for (const stream of list) {
          if (stream.status === "done" && stream.result?.blob) {
            extractedEntries.push({ track, stream });
          }
        }
      }

      if (extractedEntries.length === 0) return;

      const setStatus = kind === "audio" ? setQueueAudioAllStatus : setQueueSubsAllStatus;
      const setProgress = kind === "audio" ? setQueueAudioAllProgress : setQueueSubsAllProgress;
      const setResult = kind === "audio" ? setQueueAudioAllResult : setQueueSubsAllResult;

      setStatus("extracting"); // reused as "bundling" here — same idle/extracting/done/error shape
      setProgress(0);
      setResult(null);

      const zip = new JSZip();
      const usedNames = new Set();

      // Every file's tracks share one flat zip, so prefix each entry with
      // the source filename to keep names unique and traceable.
      const uniqueName = (name) => {
        if (!usedNames.has(name)) {
          usedNames.add(name);
          return name;
        }
        const dot = name.lastIndexOf(".");
        let n = 2;
        let candidate;
        do {
          candidate = `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
          n++;
        } while (usedNames.has(candidate));
        usedNames.add(candidate);
        return candidate;
      };

      try {
        extractedEntries.forEach(({ track, stream }, i) => {
          const base = stripExt(track.name);
          const langTag = stream.language && stream.language !== "und" ? `.${stream.language}` : "";
          zip.file(uniqueName(`${base}${langTag}.${stream.result.extension}`), stream.result.blob);
          setProgress((i + 1) / extractedEntries.length);
        });

        const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
        setStatus("done");
        setProgress(1);
        setResult(zipBlob);
      } catch {
        setStatus("error");
        setProgress(0);
      }
    },
    []
  );

  const extractAllAudioQueue = useCallback(
    () => bundleExtractedOfKindForQueue("audio"),
    [bundleExtractedOfKindForQueue]
  );
  const extractAllSubtitlesQueue = useCallback(
    () => bundleExtractedOfKindForQueue("subtitle"),
    [bundleExtractedOfKindForQueue]
  );

  // ---- queue-level: "target languages" extract, across every file at once.
  // Given a set of selected language codes, walks every track's streams of
  // one kind, extracts any matching stream that hasn't already been pulled
  // (reusing an already-"done" one instead of re-running ffmpeg on it), and
  // zips the whole set together. This is what powers the "Target
  // languages…" picker on the queue toolbar — one click extracts + bundles
  // only the languages the user actually wants, across the whole queue.
  const extractByLanguageForQueue = useCallback(
    async (kind, selectedCodes, selectedFileIds) => {
      const codes = new Set(selectedCodes);
      // no fileIds passed (or falsy) means "every file" — keeps the function
      // usable without the file filter for callers that don't need it
      const fileIds = selectedFileIds ? new Set(selectedFileIds) : null;
      const tracksAtStart = tracksRef.current;
      const entries = [];
      for (const track of tracksAtStart) {
        if (fileIds && !fileIds.has(track.id)) continue;
        const list = kind === "audio" ? track.audioStreams : track.subtitleStreams;
        for (const stream of list) {
          if (codes.has(stream.language || "und")) {
            entries.push({ trackId: track.id, streamIndex: stream.index });
          }
        }
      }
      if (entries.length === 0) return;

      const setStatus = kind === "audio" ? setQueueAudioAllStatus : setQueueSubsAllStatus;
      const setProgress = kind === "audio" ? setQueueAudioAllProgress : setQueueSubsAllProgress;
      const setResult = kind === "audio" ? setQueueAudioAllResult : setQueueSubsAllResult;

      setStatus("extracting");
      setProgress(0);
      setResult(null);

      const zip = new JSZip();
      const usedNames = new Set();
      const uniqueName = (name) => {
        if (!usedNames.has(name)) {
          usedNames.add(name);
          return name;
        }
        const dot = name.lastIndexOf(".");
        let n = 2;
        let candidate;
        do {
          candidate = `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
          n++;
        } while (usedNames.has(candidate));
        usedNames.add(candidate);
        return candidate;
      };

      try {
        for (let i = 0; i < entries.length; i++) {
          const { trackId, streamIndex } = entries[i];
          const track = tracksRef.current.find((t) => t.id === trackId);
          if (!track) {
            setProgress((i + 1) / entries.length);
            continue;
          }
          const list = kind === "audio" ? track.audioStreams : track.subtitleStreams;
          const stream = list.find((s) => s.index === streamIndex);
          if (!stream) {
            setProgress((i + 1) / entries.length);
            continue;
          }

          let blob, extension;
          if (stream.status === "done" && stream.result?.blob) {
            // already extracted by hand earlier — reuse it instead of redoing the work
            blob = stream.result.blob;
            extension = stream.result.extension;
          } else {
            const res = await extractOneStream(trackId, kind, streamIndex);
            if (!res) {
              setProgress((i + 1) / entries.length);
              continue; // that one stream failed — skip it, keep going with the rest
            }
            blob = res.blob;
            extension = res.extension;
          }

          const base = stripExt(track.name);
          const langTag = stream.language && stream.language !== "und" ? `.${stream.language}` : "";
          zip.file(uniqueName(`${base}${langTag}.${extension}`), blob);
          setProgress((i + 1) / entries.length);
        }

        const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
        setStatus("done");
        setProgress(1);
        setResult(zipBlob);
      } catch (err) {
        console.error(`[extractByLanguage:${kind}] failed:`, err);
        setStatus("error");
        setProgress(0);
      }
    },
    [extractOneStream]
  );

  const extractAudioByLanguageQueue = useCallback(
    (codes, fileIds) => extractByLanguageForQueue("audio", codes, fileIds),
    [extractByLanguageForQueue]
  );
  const extractSubtitlesByLanguageQueue = useCallback(
    (codes, fileIds) => extractByLanguageForQueue("subtitle", codes, fileIds),
    [extractByLanguageForQueue]
  );

  // Per-language counts across the whole queue, live — feeds the "target
  // languages" picker so it can show e.g. "Korean · 4 tracks · 2 files".
  const audioLanguageOptions = buildLanguageOptions(tracks, "audio");
  const subtitleLanguageOptions = buildLanguageOptions(tracks, "subtitle");

  // Counts of already-extracted (status "done") streams of each kind across
  // the whole queue right now — used to enable/disable + label the queue
  // bundle buttons ("Bundle extracted (3)").
  const queueAudioExtractedCount = tracks.reduce(
    (n, t) => n + t.audioStreams.filter((s) => s.status === "done").length,
    0
  );
  const queueSubsExtractedCount = tracks.reduce(
    (n, t) => n + t.subtitleStreams.filter((s) => s.status === "done").length,
    0
  );

  const downloadAllAudioQueue = useCallback(() => {
    if (!queueAudioAllResult) return;
    downloadBlob(queueAudioAllResult, "all-audio.zip");
  }, [queueAudioAllResult]);

  const downloadAllSubtitlesQueue = useCallback(() => {
    if (!queueSubsAllResult) return;
    downloadBlob(queueSubsAllResult, "all-subtitles.zip");
  }, [queueSubsAllResult]);

  // "Download all": saves the already-built zip, no re-extraction.
  const downloadAllAudio = useCallback((trackId) => {
    const track = tracksRef.current.find((t) => t.id === trackId);
    if (!track?.audioAllResult) return;
    const base = stripExt(track.name);
    downloadBlob(track.audioAllResult, `${base}-audio.zip`);
  }, []);

  const downloadAllSubtitles = useCallback((trackId) => {
    const track = tracksRef.current.find((t) => t.id === trackId);
    if (!track?.subsAllResult) return;
    const base = stripExt(track.name);
    downloadBlob(track.subsAllResult, `${base}-subtitles.zip`);
  }, []);

  return {
    tracks,
    engineState,
    engineError,
    addFiles,
    setAudioFormat,
    removeTrack,
    extractOneAudio,
    extractOneSubtitle,
    downloadOneAudio,
    downloadOneSubtitle,
    extractAllAudio,
    extractAllSubtitles,
    downloadAllAudio,
    downloadAllSubtitles,
    // queue-wide: bundles already-extracted streams of one kind, across every
    // file, into one zip — kept separate from each other
    queueAudioAllStatus,
    queueAudioAllProgress,
    extractAllAudioQueue,
    downloadAllAudioQueue,
    queueAudioExtractedCount,
    queueSubsAllStatus,
    queueSubsAllProgress,
    extractAllSubtitlesQueue,
    downloadAllSubtitlesQueue,
    queueSubsExtractedCount,
    // "target languages" picker: pick which language(s) to extract, across
    // every file in the queue, in one go
    audioLanguageOptions,
    subtitleLanguageOptions,
    extractAudioByLanguageQueue,
    extractSubtitlesByLanguageQueue,
  };
}
