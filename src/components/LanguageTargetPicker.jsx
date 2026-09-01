import { useState } from "react";

// Modal shown when the user clicks "Target languages…" on the queue toolbar.
// Lists every language present among the queue's audio (or subtitle) tracks
// with checkboxes, defaulting to all-selected so "extract everything" still
// takes one click, while letting the user narrow it down to just the
// languages they actually want pulled out — across every file at once.
export default function LanguageTargetPicker({ kind, options, onCancel, onConfirm }) {
  const [selected, setSelected] = useState(() => new Set(options.map((o) => o.code)));

  const toggle = (code) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const kindLabel = kind === "audio" ? "audio" : "subtitle";

  return (
    <div className="lang-picker-overlay" onClick={onCancel}>
      <div
        className="lang-picker"
        role="dialog"
        aria-modal="true"
        aria-label={`Target ${kindLabel} languages`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lang-picker__head">
          <h3>Target {kindLabel} languages</h3>
          <button type="button" className="lang-picker__close" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="lang-picker__hint">
          Pick which languages to extract — every matching {kindLabel} track across every file in the
          queue gets pulled and zipped together.
        </p>

        <div className="lang-picker__toolbar">
          <button
            type="button"
            className="lang-picker__link"
            onClick={() => setSelected(new Set(options.map((o) => o.code)))}
          >
            Select all
          </button>
          <button type="button" className="lang-picker__link" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>

        <ul className="lang-picker__list">
          {options.map((opt) => (
            <li key={opt.code} className="lang-picker__row">
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(opt.code)}
                  onChange={() => toggle(opt.code)}
                />
                <span className="lang-picker__label">{opt.label}</span>
                <span className="lang-picker__count">
                  {opt.streamCount} track{opt.streamCount === 1 ? "" : "s"} · {opt.fileCount} file
                  {opt.fileCount === 1 ? "" : "s"}
                </span>
              </label>
            </li>
          ))}
        </ul>

        <div className="lang-picker__actions">
          <button type="button" className="lang-picker__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="lang-picker__run"
            disabled={selected.size === 0}
            onClick={() => onConfirm(Array.from(selected))}
          >
            {selected.size > 0
              ? `Extract (${selected.size} language${selected.size === 1 ? "" : "s"})`
              : "Extract"}
          </button>
        </div>
      </div>
    </div>
  );
}
