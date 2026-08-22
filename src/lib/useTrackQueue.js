import { useCallback, useRef, useState } from "react";
import { probeFile, extractAudio, extractSubtitle, cleanupInput, loadEngine } from "./ffmpegEngine";

let idCounter = 0;
const nextId = () => `track-${++idCounter}`;

const VIDEO_TYPES = /\.(mp4|mov|mkv|avi|flv|webm|m4v|wmv)$/i;

export function useTrackQueue() {
  const [tracks, setTracks] = useState([]);
  const [engineState, setEngineState] = useState("idle"); // idle | loading | ready
  const engineRequested = useRef(false);

  const patchTrack = useCallback((id, patch) => {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const ensureEngine = useCallback(async () => {
    if (engineRequested.current) return;
    engineRequested.current = true;
    setEngineState("loading");
    await loadEngine();
    setEngineState("ready");
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
        inputName: null,
      }));

      setTracks((prev) => [...prev, ...newTracks]);
      await ensureEngine();

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
    addFiles,
    setAudioFormat,
    toggleSubtitles,
    removeTrack,
    runExtraction,
  };
}
