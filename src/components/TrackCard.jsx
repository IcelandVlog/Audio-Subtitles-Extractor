import { formatDuration, formatSize } from "../lib/format";
import StreamTable from "./StreamTable";

const STATUS_LABEL = {
  queued: "queued",
  probing: "reading streams…",
  ready: "ready",
  error: "error",
};

export default function TrackCard({
  track,
  index,
  onSetFormat,
  onExtractOneAudio,
  onExtractOneSubtitle,
  onExtractAllAudio,
  onExtractAllSubtitles,
  onRemove,
}) {
  const {
    id,
    name,
    size,
    duration,
    status,
    audioStreams,
    subtitleStreams,
    audioAllStatus,
    audioAllProgress,
    subsAllStatus,
    subsAllProgress,
    error,
    warning,
  } = track;

  const busy =
    status === "probing" ||
    audioAllStatus === "extracting" ||
    subsAllStatus === "extracting" ||
    audioStreams.some((s) => s.status === "extracting") ||
    subtitleStreams.some((s) => s.status === "extracting");

  const notReady = status !== "ready";

  // rough overall percentage across whatever is currently running, so the
  // user can see total progress for this video at a glance
  const runningProgresses = [
    audioAllStatus === "extracting" ? audioAllProgress : null,
    subsAllStatus === "extracting" ? subsAllProgress : null,
    ...audioStreams.filter((s) => s.status === "extracting").map((s) => s.progress),
    ...subtitleStreams.filter((s) => s.status === "extracting").map((s) => s.progress),
  ].filter((p) => p != null);
  const overallProgress =
    runningProgresses.length > 0
      ? runningProgresses.reduce((a, b) => a + b, 0) / runningProgresses.length
      : null;

  return (
    <div className={`track track--${status}`}>
      <div className="track__meta">
        <div className="track__index" aria-hidden="true">
          {String(index + 1).padStart(2, "0")}
        </div>
        <div className="track__info">
          <p className="track__name" title={name}>
            {name}
          </p>
          <p className="track__sub">
            {formatDuration(duration)} <span className="dot">·</span> {formatSize(size)}
            <span className="dot">·</span>
            <span className={`track__status track__status--${status}`}>{STATUS_LABEL[status]}</span>
          </p>
        </div>
        <button className="track__remove" onClick={() => onRemove(id)} aria-label={`Remove ${name}`}>
          ✕
        </button>
      </div>

      {overallProgress != null && (
        <div className="progress">
          <div className="progress__fill" style={{ width: `${Math.max(overallProgress, 0.03) * 100}%` }} />
        </div>
      )}

      <div className="track__tables">
        <StreamTable
          kind="audio"
          title="Audio tracks"
          streams={audioStreams}
          disabled={notReady || busy}
          allStatus={audioAllStatus}
          allProgress={audioAllProgress}
          onExtractOne={(streamIndex) => onExtractOneAudio(id, streamIndex)}
          onExtractAll={() => onExtractAllAudio(id)}
          onSetFormat={(streamIndex, format) => onSetFormat(id, streamIndex, format)}
        />
        <StreamTable
          kind="subtitle"
          title="Subtitle tracks"
          streams={subtitleStreams}
          disabled={notReady || busy}
          allStatus={subsAllStatus}
          allProgress={subsAllProgress}
          onExtractOne={(streamIndex) => onExtractOneSubtitle(id, streamIndex)}
          onExtractAll={() => onExtractAllSubtitles(id)}
        />
      </div>

      {status === "error" && <p className="track__error">{error}</p>}
      {status !== "error" && warning && <p className="track__warning">{warning}</p>}
    </div>
  );
}
