import { useState } from "react";
import { formatDuration, formatSize } from "../lib/format";
import StreamTable from "./StreamTable";

const STATUS_LABEL = {
  queued: "queued",
  uploading: "uploading",
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
  onShowOneSubtitle,
  onDownloadOneSubtitle,
  onExtractAllAudio,
  onExtractAllSubtitles,
  onDownloadAllSubtitles,
  onRemove,
}) {
  const [collapsed, setCollapsed] = useState(false);

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
    uploadProgress,
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
    status === "uploading"
      ? uploadProgress
      : runningProgresses.length > 0
      ? runningProgresses.reduce((a, b) => a + b, 0) / runningProgresses.length
      : null;

  return (
    <div className={`track track--${status}`}>
      <div
        className="track__meta"
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
      >
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
            <span className={`track__status track__status--${status}`}>
              {STATUS_LABEL[status]}
              {status === "uploading" ? ` ${Math.round(uploadProgress * 100)}%` : ""}
            </span>
          </p>
        </div>
        <span
          className={`track__chevron ${collapsed ? "track__chevron--collapsed" : ""}`}
          aria-hidden="true"
        >
          ▾
        </span>
        <button
          className="track__remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(id);
          }}
          aria-label={`Remove ${name}`}
        >
          ✕
        </button>
      </div>

      {overallProgress != null && (
        <div className="progress">
          <div className="progress__fill" style={{ width: `${Math.max(overallProgress, 0.03) * 100}%` }} />
        </div>
      )}

      {!collapsed && (
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
            onShowOne={(streamIndex) => onShowOneSubtitle(id, streamIndex)}
            onDownloadOne={(streamIndex) => onDownloadOneSubtitle(id, streamIndex)}
            onExtractAll={() => onExtractAllSubtitles(id)}
            onDownloadAll={() => onDownloadAllSubtitles(id)}
          />
        </div>
      )}

      {status === "error" && <p className="track__error">{error}</p>}
      {status !== "error" && warning && <p className="track__warning">{warning}</p>}
    </div>
  );
}
