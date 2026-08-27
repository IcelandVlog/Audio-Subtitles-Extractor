import { Suspense, lazy, useEffect, useState } from "react";
import { useTrackQueue } from "./lib/useTrackQueue";
import { usePath, toolPathFor, toolIdFromPath } from "./lib/router";
import Meter from "./components/Meter";
import Dropzone from "./components/Dropzone";
import TrackCard from "./components/TrackCard";
import AllToolsMenu from "./components/AllToolsMenu";
import ToolPage from "./components/ToolPage";
import LyricsEditor from "./components/LyricsEditor";
import "./App.css";

// Pulls in @huggingface/transformers + onnxruntime-web (large) — only fetched
// when someone actually opens this tool, not on every page load.
const VideoTranscriber = lazy(() => import("./components/VideoTranscriber"));

const THEME_KEY = "strip-theme";

export default function App() {
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "dark";
    return localStorage.getItem(THEME_KEY) || "dark";
  });
  const [path, navigate] = usePath();
  const activeToolId = toolIdFromPath(path);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const {
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
    queueAudioAllStatus,
    queueAudioAllProgress,
    extractAllAudioQueue,
    downloadAllAudioQueue,
    queueSubsAllStatus,
    queueSubsAllProgress,
    extractAllSubtitlesQueue,
    downloadAllSubtitlesQueue,
  } = useTrackQueue();

  const anyBusy = tracks.some(
    (t) =>
      t.status === "probing" ||
      t.audioAllStatus === "extracting" ||
      t.subsAllStatus === "extracting" ||
      t.audioStreams.some((s) => s.status === "extracting") ||
      t.subtitleStreams.some((s) => s.status === "extracting")
  );

  const goHome = () => navigate("/");

  return (
    <>
      <div className="grain" />
      <header className="nav">
        <button type="button" className="nav__mark nav__mark--link" onClick={goHome}>
          <span className="nav__dot" />
          STRIP
        </button>
        <div className="nav__tools">
          <AllToolsMenu
            onSelectTool={(id) => navigate(id === "extract-subtitles-from-video" ? "/" : toolPathFor(id))}
          />
          <a
            className="all-tools__btn"
            href="https://subtitle-translator-orpin.vercel.app"
            target="_blank"
            rel="noreferrer"
          >
            Subtitle Translate
          </a>
        </div>
        <div className="nav__right">
          <a
            className="nav__link"
            href="https://github.com/Bisalkumar/Audio-Extractor"
            target="_blank"
            rel="noreferrer"
          >
            source ↗
          </a>
          <button
            type="button"
            className="nav__theme"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      {activeToolId === "timed-lyrics-editor" ? (
        <LyricsEditor onHome={goHome} />
      ) : activeToolId === "video-to-subtitles" ? (
        <Suspense
          fallback={
            <main className="shell">
              <p className="tool-page__hint">Loading the transcriber…</p>
            </main>
          }
        >
          <VideoTranscriber onHome={goHome} />
        </Suspense>
      ) : activeToolId ? (
        <ToolPage key={activeToolId} toolId={activeToolId} onHome={goHome} />
      ) : (
        <main className="shell">
          <section className="hero">
            <p className="eyebrow">client-side media console</p>
            <h1 className="hero__title">
              Pull the sound.
              <br />
              Pull the words.
            </h1>
            <p className="hero__sub">
              Drop in one or many videos and Strip lists every audio and subtitle track it finds —
              pull one out at a time, or grab everything of a kind at once as a zip. Everything runs
              in this browser tab, so nothing ever leaves your machine.
            </p>
            <Meter active={anyBusy} />
          </section>

          {engineState === "error" && <p className="engine-error">{engineError}</p>}

          <Dropzone onFiles={addFiles} engineState={engineState} />

          {tracks.length > 0 && (
            <section className="queue">
              <div className="queue__header">
                <span>queue</span>
                <span>{tracks.length} file{tracks.length > 1 ? "s" : ""}</span>
              </div>

              {tracks.length > 1 && (
                <div className="queue__bulk">
                  <QueueBulkAction
                    label="All audio"
                    status={queueAudioAllStatus}
                    progress={queueAudioAllProgress}
                    disabled={anyBusy || !tracks.some((t) => t.audioStreams.length > 0)}
                    onExtract={extractAllAudioQueue}
                    onDownload={downloadAllAudioQueue}
                  />
                  <QueueBulkAction
                    label="All subtitles"
                    status={queueSubsAllStatus}
                    progress={queueSubsAllProgress}
                    disabled={anyBusy || !tracks.some((t) => t.subtitleStreams.length > 0)}
                    onExtract={extractAllSubtitlesQueue}
                    onDownload={downloadAllSubtitlesQueue}
                  />
                </div>
              )}

              {tracks.map((t, i) => (
                <TrackCard
                  key={t.id}
                  track={t}
                  index={i}
                  onSetFormat={setAudioFormat}
                  onExtractOneAudio={extractOneAudio}
                  onDownloadOneAudio={downloadOneAudio}
                  onExtractOneSubtitle={extractOneSubtitle}
                  onDownloadOneSubtitle={downloadOneSubtitle}
                  onExtractAllAudio={extractAllAudio}
                  onDownloadAllAudio={downloadAllAudio}
                  onExtractAllSubtitles={extractAllSubtitles}
                  onDownloadAllSubtitles={downloadAllSubtitles}
                  onRemove={removeTrack}
                />
              ))}
            </section>
          )}
        </main>
      )}

      <footer className="footer">
        <p>
          Built on <span className="mono">ffmpeg.wasm</span> — decoding happens on your CPU, in your
          tab. Large files may take a while and use real memory.
        </p>
      </footer>
    </>
  );
}

// One "Extract all <kind>, across every file" control for the queue toolbar.
// Audio and subtitles each get their own instance, so the two stay separate
// zips even though both pull from every file in the queue at once.
function QueueBulkAction({ label, status, progress, disabled, onExtract, onDownload }) {
  return (
    <div className="queue__bulk-item">
      <span className="queue__bulk-label">{label}</span>
      {status === "extracting" ? (
        <span className="queue__bulk-progress">{Math.round(progress * 100)}%</span>
      ) : status === "done" ? (
        <button type="button" className="queue__bulk-btn" onClick={onDownload}>
          Download all ↓
        </button>
      ) : (
        <button
          type="button"
          className="queue__bulk-btn"
          disabled={disabled}
          onClick={onExtract}
          title={`Extract ${label.toLowerCase()} from every file, zipped together`}
        >
          Extract all files
        </button>
      )}
      {status === "error" && <span className="queue__bulk-error">failed</span>}
    </div>
  );
}
