import { useCallback, useRef, useState } from "react";
import { probeFile, extractAudio, extractSubtitle, cleanupInput, loadEngine } from "./ffmpegEngine";

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

export function useTrackQueue() {
  const [tracks, setTracks] = useState([]);
  const [engineState, setEngineState] = useState("idle"); // idle | loading | ready | error
  const [engineError, setEngineError] = useState(null);
  const engineRequested = useRef(false);

  const patchTrack = useCallback((id, patch) => {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
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
        status: "queued", // queued | probing | ready | extracting | done | error
        audioFormat: "mp3",
        duration: null,
        subtitleStreams: [],
        selectedSubtitle: null,
        wantSubtitles: false,
        progress: 0,
        audioResult: null,
        subtitleResult: null,
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

      for (const t of newTracks) {
        patchTrack(t.id, { status: "probing" });
        try {
          const { inputName, streams, duration } = await probeFile(t.file);
          const subtitleStreams = streams.filter((s) => s.type === "Subtitle");
          patchTrack(t.id, {
            status: "ready",
            inputName,
            duration,
            subtitleStreams,
            selectedSubtitle: subtitleStreams[0]?.index ?? null,
            wantSubtitles: subtitleStreams.length > 0,
          });
        } catch (err) {
          patchTrack(t.id, { status: "error", error: "Couldn't read this file." });
        }
      }
    },
    [ensureEngine, patchTrack]
  );

  const setAudioFormat = useCallback(
    (id, format) => patchTrack(id, { audioFormat: format }),
    [patchTrack]
  );

  const toggleSubtitles = useCallback(
    (id, want) => patchTrack(id, { wantSubtitles: want }),
    [patchTrack]
  );

  const removeTrack = useCallback((id) => {
    setTracks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const runExtraction = useCallback(
    async (id) => {
      const track = tracks.find((t) => t.id === id);
      if (!track || track.status === "extracting") return;

      patchTrack(id, { status: "extracting", progress: 0, error: null });
      try {
        const audioBlob = await extractAudio({
          inputName: track.inputName,
          format: track.audioFormat,
          onProgress: (p) => patchTrack(id, { progress: p }),
        });

        let subtitleResult = null;
        if (track.wantSubtitles && track.selectedSubtitle != null) {
          const stream = track.subtitleStreams.find((s) => s.index === track.selectedSubtitle);
          const { blob, extension } = await extractSubtitle({
            inputName: track.inputName,
            streamIndex: track.selectedSubtitle,
            codec: stream?.codec,
          });
          subtitleResult = { url: URL.createObjectURL(blob), extension };
        }

        patchTrack(id, {
          status: "done",
          progress: 1,
          audioResult: { url: URL.createObjectURL(audioBlob), extension: track.audioFormat },
          subtitleResult,
        });
        cleanupInput(track.inputName);
      } catch (err) {
        patchTrack(id, { status: "error", error: "Extraction failed. Try a different format." });
      }
    },
    [tracks, patchTrack]
  );

  return {
    tracks,
    engineState,
    engineError,
    addFiles,
    setAudioFormat,
    toggleSubtitles,
    removeTrack,
    runExtraction,
  };
}
