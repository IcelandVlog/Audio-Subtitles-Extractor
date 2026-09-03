import { useState } from "react";
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
  onShowOne,
  onDownloadOne,
  onDownloadAll,
  onDetectLanguage,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const isAudio = kind === "audio";
  const hasStreams = streams.length > 0;
  const allRunning = allStatus === "extracting";

  return (
    <div className={`stream-table${collapsed ? " stream-table--collapsed" : ""}`}>
      <div
        className="stream-table__head"
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
        <span>
          {title}
          {hasStreams && <span className="stream-table__count">{streams.length}</span>}
        </span>
        <span className="stream-table__head-right">
          {hasStreams &&
            (allRunning ? (
              <span className="stream-table__all-progress">{Math.round(allProgress * 100)}%</span>
            ) : allStatus === "done" ? (
              <button
                className="stream-table__all-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDownloadAll();
                }}
              >
                Download all
              </button>
            ) : (
              <button
                className="stream-table__all-btn"
                disabled={disabled || streams.length < 2}
                onClick={(e) => {
                  e.stopPropagation();
                  onExtractAll();
                }}
                title={streams.length < 2 ? "Only one track — use Extract" : "Extract every track, zipped"}
              >
                Extract all
              </button>
            ))}
          <span className="stream-table__chevron" aria-hidden="true">
            ▾
          </span>
        </span>
      </div>

      <div className="stream-table__body">
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
                {isAudio && (!s.language || s.language === "und") && (
                  <button
                    type="button"
                    className="stream-row__detect"
                    disabled={
                      disabled || allRunning || s.status === "extracting" || s.languageDetectStatus === "detecting"
                    }
                    onClick={() => onDetectLanguage(s.index)}
                    title="Guess the spoken language from the audio itself (runs a small speech model in your browser)"
                  >
                    {s.languageDetectStatus === "detecting"
                      ? "Detecting…"
                      : s.languageDetectStatus === "error"
                      ? "Detect failed — retry"
                      : "Detect language"}
                  </button>
                )}
                <span className="stream-row__ext">
                  {isAudio ? null : `.${guessSubtitleExtension(s.codec)}`}
                </span>
              </div>

              {isAudio && (
                <select
                  className="stream-row__format"
                  value={s.format}
                  disabled={disabled || allRunning || s.status === "extracting"}
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
                  <>
                    {!isAudio && (
                      <button className="stream-row__link" onClick={() => onShowOne(s.index)}>
                        Show
                      </button>
                    )}
                    <button className="stream-row__link" onClick={() => onDownloadOne(s.index)}>
                      Download
                    </button>
                  </>
                ) : (
                  // While "Extract all" is running, every row that isn't the
                  // one currently being processed stays on this idle "Extract"
                  // button, just disabled — no stale "0%" on rows that haven't
                  // had their turn yet, and no way to kick off a second
                  // extraction on top of the running one.
                  <button
                    className="stream-row__link"
                    disabled={disabled || allRunning}
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
    </div>
  );
}
