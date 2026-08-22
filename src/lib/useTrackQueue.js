import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { probeFile, extractAudio, extractSubtitle, cleanupInput, loadEngine } from "./ffmpegEngine";
import { downloadBlob, stripExt } from "./download";
import { languageLabel } from "./languages";

let idCounter = 0;
const nextId = () => `track-${++idCounter}`;

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
    format: "mp3",
    status: "idle", // idle | extracting | done | error
    progress: 0,
    result: null, // { extension }
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
    result: null,
    error: null,
  };
}

export function useTrackQueue() {
  const [tracks, setTracks] = useState([]);
  const [engineState, setEngineState] = useState("idle"); // idle | loading | ready | error
  const [engineError, setEngineError] = useState(null);
  const engineRequested = useRef(false);
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
        status: "queued", // queued | probing | ready | error
        duration: null,
        audioStreams: [],
        subtitleStreams: [],
        audioAllStatus: "idle", // idle | extracting | done | error
        audioAllProgress: 0,
        subsAllStatus: "idle",
        subsAllProgress: 0,
        error: null,
        warning:
          file.size > LARGE_FILE_WARNING_BYTES
            ? "Large file — this may be slow or run out of memory in some browsers."
            : null,
        inputName: null,
      }));

      setTracks((prev) => [...prev, ...newTracks]);

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
        patchTrack(t.id, { status: "probing" });
        try {
          const { inputName, streams, duration } = await probeFile(t.file);
          const audioStreams = streams.filter((s) => s.type === "Audio").map(makeAudioStream);
          const subtitleStreams = streams.filter((s) => s.type === "Subtitle").map(makeSubtitleStream);
          patchTrack(t.id, {
            status: "ready",
            inputName,
            duration,
            audioStreams,
            subtitleStreams,
          });
        } catch {
          patchTrack(t.id, { status: "error", error: "Couldn't read this file." });
        }
      }
    },
    [ensureEngine, patchTrack]
  );

  const setAudioFormat = useCallback(
    (trackId, streamIndex, format) => patchStream(trackId, "audio", streamIndex, { format }),
    [patchStream]
  );

  const removeTrack = useCallback((id) => {
    setTracks((prev) => {
      const t = prev.find((x) => x.id === id);
      if (t?.inputName) cleanupInput(t.inputName);
      return prev.filter((x) => x.id !== id);
    });
  }, []);

  // ---- single-stream extraction: downloads the resulting file directly, no zip ----
  const extractOneStream = useCallback(
    async (trackId, kind, streamIndex) => {
      const track = tracksRef.current.find((t) => t.id === trackId);
      if (!track) return;
      const list = kind === "audio" ? track.audioStreams : track.subtitleStreams;
      const stream = list.find((s) => s.index === streamIndex);
      if (!stream || stream.status === "extracting") return;

      patchStream(trackId, kind, streamIndex, { status: "extracting", progress: 0, error: null });
      try {
        const base = stripExt(track.name);
        const langTag = stream.language && stream.language !== "und" ? `.${stream.language}` : "";

        if (kind === "audio") {
          const blob = await extractAudio({
            inputName: track.inputName,
            streamIndex,
            format: stream.format,
            onProgress: (p) => patchStream(trackId, kind, streamIndex, { progress: p }),
          });
          patchStream(trackId, kind, streamIndex, {
            status: "done",
            progress: 1,
            result: { extension: stream.format },
          });
          downloadBlob(blob, `${base}${langTag}.${stream.format}`);
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
            result: { extension },
          });
          downloadBlob(blob, `${base}${langTag}.${extension}`);
        }
      } catch {
        patchStream(trackId, kind, streamIndex, { status: "error", error: "Extraction failed." });
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
        for (let i = 0; i < list.length; i++) {
          const stream = list[i];
          patchStream(trackId, kind, stream.index, { status: "extracting", progress: 0, error: null });

          const onProgress = (p) => {
            perStreamProgress[i] = p;
            reportOverall();
            patchStream(trackId, kind, stream.index, { progress: p });
          };

          const langTag = stream.language && stream.language !== "und" ? `.${stream.language}` : "";

          if (kind === "audio") {
            const blob = await extractAudio({
              inputName: track.inputName,
              streamIndex: stream.index,
              format: stream.format,
              onProgress,
            });
            zip.file(uniqueName(`${base}${langTag}.${stream.format}`), blob);
            patchStream(trackId, kind, stream.index, {
              status: "done",
              progress: 1,
              result: { extension: stream.format },
            });
          } else {
            const { blob, extension } = await extractSubtitle({
              inputName: track.inputName,
              streamIndex: stream.index,
              codec: stream.codec,
              onProgress,
            });
            zip.file(uniqueName(`${base}${langTag}.${extension}`), blob);
            patchStream(trackId, kind, stream.index, {
              status: "done",
              progress: 1,
              result: { extension },
            });
          }
          perStreamProgress[i] = 1;
          reportOverall();
        }

        const zipBlob = await zip.generateAsync({ type: "blob" });
        downloadBlob(zipBlob, `${base}-${kind === "audio" ? "audio" : "subtitles"}.zip`);
        patchTrack(trackId, { [statusKey]: "done", [progressKey]: 1 });
      } catch {
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

  return {
    tracks,
    engineState,
    engineError,
    addFiles,
    setAudioFormat,
    removeTrack,
    extractOneAudio,
    extractOneSubtitle,
    extractAllAudio,
    extractAllSubtitles,
  };
}
