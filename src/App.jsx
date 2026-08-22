import { useTrackQueue } from "./lib/useTrackQueue";
import Meter from "./components/Meter";
import Dropzone from "./components/Dropzone";
import TrackCard from "./components/TrackCard";
import "./App.css";

export default function App() {
  const {
    tracks,
    engineState,
    engineError,
    addFiles,
    setAudioFormat,
    removeTrack,
    extractOneAudio,
    extractOneSubtitle,
    downloadOneSubtitle,
    extractAllAudio,
    extractAllSubtitles,
    downloadAllSubtitles,
  } = useTrackQueue();

  const anyBusy = tracks.some(
    (t) =>
      t.status === "probing" ||
      t.audioAllStatus === "extracting" ||
      t.subsAllStatus === "extracting" ||
      t.audioStreams.some((s) => s.status === "extracting") ||
      t.subtitleStreams.some((s) => s.status === "extracting")
  );

  return (
    <>
      <div className="grain" />
      <header className="nav">
        <div className="nav__mark">
          <span className="nav__dot" />
          STRIP
        </div>
        <a
          className="nav__link"
          href="https://github.com/Bisalkumar/Audio-Extractor"
          target="_blank"
          rel="noreferrer"
        >
          source ↗
        </a>
      </header>

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
            {tracks.map((t, i) => (
              <TrackCard
                key={t.id}
                track={t}
                index={i}
                onSetFormat={setAudioFormat}
                onExtractOneAudio={extractOneAudio}
                onExtractOneSubtitle={extractOneSubtitle}
                onDownloadOneSubtitle={downloadOneSubtitle}
                onExtractAllAudio={extractAllAudio}
                onExtractAllSubtitles={extractAllSubtitles}
                onDownloadAllSubtitles={downloadAllSubtitles}
                onRemove={removeTrack}
              />
            ))}
          </section>
        )}
      </main>

      <footer className="footer">
        <p>
          Built on <span className="mono">ffmpeg.wasm</span> — decoding happens on your CPU, in your
          tab. Large files may take a while and use real memory.
        </p>
      </footer>
    </>
  );
}
