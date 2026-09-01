import { useState } from "react";

// Modal shown when the user clicks "Target languages…" on the queue toolbar.
// Two pickable sections:
//   - which FILES in the queue to pull from (defaults to all selected)
//   - which LANGUAGES to pull, of the requested kind (defaults to all selected)
// Both default to all-selected so "extract everything" still takes one
// click, while letting the user narrow either dimension down — e.g. only
// episodes 1–3, or only Korean — across the whole queue at once.
export default function LanguageTargetPicker({ kind, options, files, onCancel, onConfirm }) {
  const [selectedLangs, setSelectedLangs] = useState(() => new Set(options.map((o) => o.code)));
  const [selectedFiles, setSelectedFiles] = useState(() => new Set(files.map((f) => f.id)));

  const toggleLang = (code) => {
    setSelectedLangs((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const toggleFile = (id) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const kindLabel = kind === "audio" ? "audio" : "subtitle";
  const canRun = selectedLangs.size > 0 && selectedFiles.size > 0;

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
          Pick which files and which languages to extract — every matching {kindLabel} track gets
          pulled and zipped together.
        </p>

        <div className="lang-picker__scroll">
          {files.length > 1 && (
            <>
              <div className="lang-picker__section-head">
                <span className="lang-picker__section-title">Files</span>
                <div className="lang-picker__toolbar">
                  <button
                    type="button"
                    className="lang-picker__link"
                    onClick={() => setSelectedFiles(new Set(files.map((f) => f.id)))}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="lang-picker__link"
                    onClick={() => setSelectedFiles(new Set())}
                  >
                    Clear
                  </button>
                </div>
              </div>

              <ul className="lang-picker__list">
                {files.map((f) => (
                  <li key={f.id} className="lang-picker__row">
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedFiles.has(f.id)}
                        onChange={() => toggleFile(f.id)}
                      />
                      <span className="lang-picker__label" title={f.name}>
                        {f.name}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="lang-picker__section-head">
            <span className="lang-picker__section-title">Languages</span>
            <div className="lang-picker__toolbar">
              <button
                type="button"
                className="lang-picker__link"
                onClick={() => setSelectedLangs(new Set(options.map((o) => o.code)))}
              >
                Select all
              </button>
              <button
                type="button"
                className="lang-picker__link"
                onClick={() => setSelectedLangs(new Set())}
              >
                Clear
              </button>
            </div>
          </div>

          <ul className="lang-picker__list">
            {options.map((opt) => (
              <li key={opt.code} className="lang-picker__row">
                <label>
                  <input
                    type="checkbox"
                    checked={selectedLangs.has(opt.code)}
                    onChange={() => toggleLang(opt.code)}
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
        </div>

        <div className="lang-picker__actions">
          <button type="button" className="lang-picker__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="lang-picker__run"
            disabled={!canRun}
            onClick={() => onConfirm(Array.from(selectedLangs), Array.from(selectedFiles))}
          >
            {canRun
              ? `Extract (${selectedLangs.size} lang${selectedLangs.size === 1 ? "" : "s"} · ${
                  selectedFiles.size
                } file${selectedFiles.size === 1 ? "" : "s"})`
              : "Extract"}
          </button>
        </div>
      </div>
    </div>
  );
}
