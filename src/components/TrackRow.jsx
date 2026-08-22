import { formatDuration, formatSize } from "../lib/format";

const AUDIO_FORMATS = ["mp3", "wav", "ogg", "flac", "aac"];

const STATUS_LABEL = {
  queued: "queued",
  probing: "reading streams…",
  ready: "ready",
  extracting: "extracting…",
  done: "done",
  error: "error",
};

export default function TrackRow({ track, index, onSetFormat, onToggleSubs, onExtract, onRemove }) {
  const {
    id,
    name,
    size,
    duration,
    status,
    audioFormat,
    subtitleStreams,
    wantSubtitles,
    progress,
    audioResult,
    subtitleResult,
    error,
    warning,
  } = track;

  const busy = status === "probing" || status === "extracting";
  const hasSubs = subtitleStreams.length > 0;

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

      <div className="track__controls">
        <div className="control">
          <span className="control__label">audio out</span>
          <div className="format-picker">
            {AUDIO_FORMATS.map((fmt) => (
              <button
                key={fmt}
                className={`format-picker__btn ${audioFormat === fmt ? "is-selected" : ""}`}
                disabled={busy}
                onClick={() => onSetFormat(id, fmt)}
              >
                {fmt}
              </button>
            ))}
          </div>
        </div>

        <div className="control">
          <span className="control__label">subtitles</span>
          {hasSubs ? (
            <label className="toggle">
              <input
                type="checkbox"
                checked={wantSubtitles}
                disabled={busy}
                onChange={(e) => onToggleSubs(id, e.target.checked)}
              />
              <span className="toggle__track">
                <span className="toggle__thumb" />
              </span>
              <span className="toggle__text">
                extract {subtitleStreams.length > 1 ? `(${subtitleStreams.length} tracks found)` : ""}
              </span>
            </label>
          ) : (
            <span className="control__empty">
              {status === "probing" ? "checking…" : "none found in this file"}
            </span>
          )}
        </div>
      </div>

      <div className="track__action">
        {status === "extracting" && (
          <div className="progress">
            <div className="progress__fill" style={{ width: `${Math.max(progress, 0.03) * 100}%` }} />
          </div>
        )}

        {status === "done" ? (
          <div className="results">
            <a className="btn btn--ghost" href={audioResult.url} download={`${stripExt(name)}.${audioResult.extension}`}>
              ↓ audio.{audioResult.extension}
            </a>
            {subtitleResult && (
              <a
                className="btn btn--ghost"
                href={subtitleResult.url}
                download={`${stripExt(name)}.${subtitleResult.extension}`}
              >
                ↓ subs.{subtitleResult.extension}
              </a>
            )}
          </div>
        ) : (
          <button
            className="btn btn--primary"
            disabled={status !== "ready"}
            onClick={() => onExtract(id)}
          >
            {status === "extracting" ? "Extracting…" : "Extract"}
          </button>
        )}

        {status === "error" && <p className="track__error">{error}</p>}
        {status !== "error" && warning && <p className="track__warning">{warning}</p>}
      </div>
    </div>
  );
}

function stripExt(name) {
  return name.replace(/\.[^./]+$/, "");
}
