import { guessSubtitleExtension } from "../lib/ffmpegEngine";

const AUDIO_FORMATS = ["mp3", "wav", "ogg", "flac", "aac"];

export default function StreamTable({
  kind, // "audio" | "subtitle"
  title,
  streams,
  disabled,
  allStatus,
  allProgress,
  onExtractOne,
  onExtractAll,
  onSetFormat,
}) {
  const isAudio = kind === "audio";
  const hasStreams = streams.length > 0;
  const allRunning = allStatus === "extracting";

  return (
    <div className="stream-table">
      <div className="stream-table__head">
        <span>{title}</span>
        {hasStreams &&
          (allRunning ? (
            <span className="stream-table__all-progress">{Math.round(allProgress * 100)}%</span>
          ) : (
            <button
              className="stream-table__all-btn"
              disabled={disabled || streams.length < 2}
              onClick={onExtractAll}
              title={streams.length < 2 ? "Only one track — use Extract" : "Extract every track, zipped"}
            >
              Extract all
            </button>
          ))}
      </div>

      {!hasStreams ? (
        <p className="stream-table__empty">
          {disabled ? "checking…" : `no ${kind} tracks found`}
        </p>
      ) : (
        <ul className="stream-table__rows">
          {streams.map((s) => (
            <li key={s.index} className="stream-row">
              <div className="stream-row__label">
                <span className="stream-row__name" title={s.label}>
                  {s.label}
                </span>
                <span className="stream-row__ext">
                  {isAudio ? null : `.${guessSubtitleExtension(s.codec)}`}
                </span>
              </div>

              {isAudio && (
                <select
                  className="stream-row__format"
                  value={s.format}
                  disabled={disabled || s.status === "extracting"}
                  onChange={(e) => onSetFormat(s.index, e.target.value)}
                >
                  {AUDIO_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              )}

              <div className="stream-row__action">
                {s.status === "extracting" ? (
                  <span className="stream-row__pct">{Math.round(s.progress * 100)}%</span>
                ) : s.status === "done" ? (
                  <button
                    className="stream-row__link"
                    onClick={() => onExtractOne(s.index)}
                    title="Extract again"
                  >
                    ✓ done
                  </button>
                ) : (
                  <button
                    className="stream-row__link"
                    disabled={disabled}
                    onClick={() => onExtractOne(s.index)}
                  >
                    Extract
                  </button>
                )}
              </div>
              {s.status === "error" && <p className="stream-row__error">{s.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
