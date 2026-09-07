import { useState } from "react";
import { toSrtText } from "../lib/subtitle/formats";

function pad(n, len = 2) {
  return String(n).padStart(len, "0");
}

function msToClock(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Shows every frame the .sup decoded (not just the ones OCR read text from)
// with its source image next to an editable text box, so a person can spot
// and fix OCR mistakes or manually fill in frames OCR missed entirely, then
// re-download a corrected .srt for just this file.
export default function SupInspectModal({ fileEntry, onClose }) {
  const [rows, setRows] = useState(() => fileEntry.frames.map((f) => ({ ...f })));

  const updateText = (i, text) => {
    setRows((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], text };
      return next;
    });
  };

  const handleDownload = () => {
    const cues = rows
      .filter((r) => r.text.trim() !== "")
      .map((r) => ({ start: r.start, end: r.end, text: r.text.trim() }));
    downloadText(fileEntry.srtName, toSrtText(cues));
  };

  const filledCount = rows.filter((r) => r.text.trim() !== "").length;

  return (
    <div className="inspect-overlay" onClick={onClose}>
      <div
        className="inspect-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Inspect ${fileEntry.fileName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="inspect-modal__head">
          <div className="inspect-modal__head-info">
            <h3 title={fileEntry.fileName}>{fileEntry.fileName}</h3>
            <span className="inspect-modal__count">
              {filledCount} of {rows.length} frames have text — edit any box below, then download
            </span>
          </div>
          <div className="inspect-modal__head-actions">
            <button type="button" className="inspect-modal__download" onClick={handleDownload}>
              Download .srt
            </button>
            <button type="button" className="inspect-modal__close" onClick={onClose} aria-label="Close inspect view">
              ✕
            </button>
          </div>
        </div>

        <div className="inspect-modal__body">
          {rows.map((row, i) => (
            <div className="inspect-row" key={i}>
              <div className="inspect-row__meta">
                <span className="inspect-row__index">{i + 1}</span>
                <span className="inspect-row__time">
                  {msToClock(row.start)} --&gt; {msToClock(row.end)}
                </span>
              </div>
              <div className="inspect-row__content">
                <img className="inspect-row__image" src={row.image} alt={`Frame ${i + 1}`} />
                <textarea
                  className="inspect-row__text"
                  value={row.text}
                  onChange={(e) => updateText(i, e.target.value)}
                  placeholder="(no text detected — type it in manually)"
                  rows={2}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
