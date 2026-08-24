import { useRef, useState } from "react";
import { probeFile, extractAudio, cleanupInput } from "../lib/ffmpegEngine";
import { decodeAudioTo16kMono, transcribeToCues, TRANSCRIBE_LANGUAGES } from "../lib/subtitle/transcribe";
import { toSrtText, toVttText, msToSrtTime } from "../lib/subtitle/formats";
import { cuesToPlainText } from "../lib/subtitle/tools";
import { cuesToPdfBlob } from "../lib/subtitle/pdf";
import { downloadBlob, stripExt } from "../lib/download";

const STAGE_LABEL = {
  probing: "Reading the file…",
  "extracting-audio": "Pulling out the audio…",
  "loading-model": "Loading the speech model…",
  transcribing: "Listening and writing it down…",
};

function fmtDuration(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

export default function VideoTranscriber({ onHome }) {
  const [file, setFile] = useState(null);
  const [quality, setQuality] = useState("fast");
  const [language, setLanguage] = useState("auto");
  const [stage, setStage] = useState("idle"); // idle | probing | extracting-audio | loading-model | transcribing | done | error
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [cues, setCues] = useState(null);
  const [hadSubtitles, setHadSubtitles] = useState(false);
  const [durationS, setDurationS] = useState(null);
  const inputRef = useRef(null);

  const busy = stage !== "idle" && stage !== "done" && stage !== "error";

  const handlePick = (f) => {
    if (!f) return;
    setFile(f);
    setStage("idle");
    setCues(null);
    setError("");
    setHadSubtitles(false);
  };

  const handleRun = async () => {
    if (!file) return;
    setError("");
    setCues(null);
    let inputName = null;
    try {
      setStage("probing");
      setProgress(0);
      const probed = await probeFile(file, { onProgress: setProgress });
      inputName = probed.inputName;
      setDurationS(probed.duration || null);

      const audioStream = probed.streams.find((s) => s.type === "Audio");
      if (!audioStream) {
        throw new Error("This file doesn't have an audio track to transcribe.");
      }
      setHadSubtitles(probed.streams.some((s) => s.type === "Subtitle"));

      setStage("extracting-audio");
      setProgress(0);
      const audioBlob = await extractAudio({
        inputName,
        streamIndex: audioStream.index,
        format: "wav",
        onProgress: setProgress,
      });

      const audioFloat32 = await decodeAudioTo16kMono(audioBlob);

      setStage("loading-model");
      setProgress(0);
      const result = await transcribeToCues(audioFloat32, {
        quality,
        language,
        onModelProgress: (p) => {
          setStage("loading-model");
          setProgress(p);
        },
        onTranscribeStart: () => {
          setStage("transcribing");
          setProgress(0);
        },
        onChunkProgress: (p) => {
          setStage("transcribing");
          setProgress(p);
        },
      });

      setProgress(1);
      setCues(result);
      setStage("done");
    } catch (err) {
      setError(err?.message || "Couldn't transcribe this file.");
      setStage("error");
    } finally {
      if (inputName) cleanupInput(inputName);
    }
  };

  const baseName = file ? stripExt(file.name) : "transcript";

  const handleDownload = (kind) => {
    if (!cues) return;
    if (kind === "srt") {
      downloadBlob(new Blob([toSrtText(cues)], { type: "text/plain" }), `${baseName}.srt`);
    } else if (kind === "vtt") {
      downloadBlob(new Blob([toVttText(cues)], { type: "text/vtt" }), `${baseName}.vtt`);
    } else if (kind === "txt") {
      downloadBlob(new Blob([cuesToPlainText(cues)], { type: "text/plain" }), `${baseName}.txt`);
    } else if (kind === "pdf") {
      downloadBlob(cuesToPdfBlob(cues, baseName), `${baseName}.pdf`);
    }
  };

  const updateCueText = (i, text) => {
    setCues((prev) => prev.map((c, idx) => (idx === i ? { ...c, text } : c)));
  };

  return (
    <main className="shell">
      <section className="tool-page">
        <button type="button" className="tool-page__back" onClick={onHome}>
          ← back to extractor
        </button>

        <p className="eyebrow">OTHER</p>
        <h1 className="tool-page__title">
          Video to Subtitle Converter
          <span className="tool-modal__beta">beta</span>
        </h1>
        <p className="tool-page__hint">
          For videos that don't already have subtitles. Strip listens to the audio track and writes
          out the dialogue, with timestamps, entirely in this browser tab — nothing is uploaded
          anywhere. The speech model downloads once on first use and is cached after that. Services
          like TurboScribe transcribe in seconds because they run on rented datacenter GPUs; this
          runs on your own device instead, which is slower but completely private.
        </p>

        <div
          className="tool-modal__drop tool-page__drop"
          onClick={() => !busy && inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!busy && e.dataTransfer.files?.[0]) handlePick(e.dataTransfer.files[0]);
          }}
          role="button"
          tabIndex={0}
        >
          <input
            ref={inputRef}
            type="file"
            hidden
            accept="video/*,audio/*,.mp4,.mov,.mkv,.avi,.webm,.mp3,.wav,.m4a"
            onChange={(e) => e.target.files?.[0] && handlePick(e.target.files[0])}
          />
          {file ? <p>{file.name}</p> : <p>Drop a video (or audio) file here or click to browse</p>}
        </div>

        {hadSubtitles && stage !== "idle" && (
          <p className="tool-page__hint">
            Heads up — this file already has an embedded subtitle track. If you just want that
            track as-is, "Extract Subtitles from Video" on the home page will be faster and more
            accurate than a fresh transcription.
          </p>
        )}

        {durationS != null && stage === "idle" && (
          <p className="tool-page__hint">
            ~{fmtDuration(durationS)} of audio. Everything runs on your device's CPU (or GPU, if
            your browser supports WebGPU) — no cloud processing — so longer files take longer,
            sometimes well beyond the clip's own length. "Fast" quality is the quickest option.
          </p>
        )}

        <div className="tool-modal__fields">
          <label className="tool-modal__field">
            <span>Speed / accuracy</span>
            <select value={quality} onChange={(e) => setQuality(e.target.value)} disabled={busy}>
              <option value="fast">Fast (smaller download, good for clear speech)</option>
              <option value="balanced">Balanced (bigger download, more accurate)</option>
            </select>
          </label>
          <label className="tool-modal__field">
            <span>Spoken language</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy}>
              {TRANSCRIBE_LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {busy && (
          <div className="tool-modal__progress">
            <div className="tool-modal__progress-bar">
              <div className="tool-modal__progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span>
              {STAGE_LABEL[stage] || "Working…"} {Math.round(progress * 100)}%
            </span>
          </div>
        )}

        {stage === "error" && <p className="tool-modal__error">{error}</p>}

        <div className="tool-modal__actions">
          <button type="button" className="tool-modal__cancel" onClick={() => handlePick(null)} disabled={busy || !file}>
            Reset
          </button>
          <button type="button" className="tool-modal__run" disabled={!file || busy} onClick={handleRun}>
            {busy ? "Working…" : "Transcribe"}
          </button>
        </div>

        {stage === "done" && cues && (
          <>
            <div className="lyrics-editor__list" style={{ marginTop: 8 }}>
              {cues.map((c, i) => (
                <div key={i} className="lyrics-row lyrics-row--transcript">
                  <span className="lyrics-row__time lyrics-row__time--static">
                    {msToSrtTime(c.start).slice(0, 8)}
                  </span>
                  <input
                    type="text"
                    className="lyrics-row__text"
                    value={c.text}
                    onChange={(e) => updateCueText(i, e.target.value)}
                  />
                </div>
              ))}
            </div>

            <div className="tool-modal__actions">
              <button type="button" className="tool-modal__download" onClick={() => handleDownload("srt")}>
                Download .srt
              </button>
              <button type="button" className="tool-modal__download" onClick={() => handleDownload("vtt")}>
                Download .vtt
              </button>
              <button type="button" className="tool-modal__download" onClick={() => handleDownload("txt")}>
                Download .txt
              </button>
              <button type="button" className="tool-modal__download" onClick={() => handleDownload("pdf")}>
                Download .pdf
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
