import { useEffect, useRef, useState } from "react";
import { TOOLS } from "../lib/subtitle";

export default function ToolModal({ toolId, onClose }) {
  const tool = toolId ? TOOLS[toolId] : null;
  const [files, setFiles] = useState([]);
  const [options, setOptions] = useState(() => defaultOptions(tool));
  const [status, setStatus] = useState("idle"); // idle | running | done | error
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!toolId) return;
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [toolId, onClose]);

  if (!tool) return null;

  const needsPair = !!tool.needsPair;
  const maxFiles = needsPair ? 2 : 1;
  const canRun = files.length === maxFiles && status !== "running";

  const handleFiles = (fileList) => {
    const picked = Array.from(fileList).slice(0, maxFiles);
    setFiles((prev) => {
      const combined = needsPair ? [...prev, ...picked].slice(-maxFiles) : picked;
      return combined;
    });
    setStatus("idle");
    setResult(null);
    setError("");
  };

  const handleRun = async () => {
    setStatus("running");
    setProgress(0);
    setError("");
    try {
      const out = await tool.run(files, options, (p) => setProgress(p));
      setResult(out);
      setStatus("done");
    } catch (err) {
      setError(err?.message || "Something went wrong converting that file.");
      setStatus("error");
    }
  };

  const handleDownload = () => {
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  return (
    <div
      className="tool-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tool-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label={tool.label}>
        <div className="tool-modal__header">
          <h2>
            {tool.label} {tool.beta && <span className="tool-modal__beta">beta</span>}
          </h2>
          <button type="button" className="tool-modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {tool.hint && <p className="tool-modal__hint">{tool.hint}</p>}

        <div
          className="tool-modal__drop"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
          }}
          role="button"
          tabIndex={0}
        >
          <input
            ref={inputRef}
            type="file"
            hidden
            accept={tool.accept}
            multiple={needsPair}
            onChange={(e) => e.target.files?.length && handleFiles(e.target.files)}
          />
          {files.length === 0 ? (
            <p>
              Drop {needsPair ? "files" : "a file"} here or click to browse
              <br />
              <span className="tool-modal__accept">{tool.accept.replaceAll(",", ", ")}</span>
            </p>
          ) : (
            <ul className="tool-modal__filelist">
              {files.map((f) => (
                <li key={f.name}>{f.name}</li>
              ))}
              {needsPair && files.length < maxFiles && <li className="tool-modal__more">+ add another file</li>}
            </ul>
          )}
        </div>

        {tool.fields.length > 0 && (
          <div className="tool-modal__fields">
            {tool.fields.map((f) => (
              <label key={f.key} className="tool-modal__field">
                <span>{f.label}</span>
                {f.type === "select" ? (
                  <select
                    value={options[f.key]}
                    onChange={(e) => setOptions((o) => ({ ...o, [f.key]: e.target.value }))}
                  >
                    {f.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="number"
                    value={options[f.key]}
                    onChange={(e) => setOptions((o) => ({ ...o, [f.key]: e.target.value }))}
                  />
                )}
              </label>
            ))}
          </div>
        )}

        {status === "running" && (
          <div className="tool-modal__progress">
            <div className="tool-modal__progress-bar">
              <div className="tool-modal__progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span>{tool.beta ? "Running OCR… this can take a minute" : "Converting…"}</span>
          </div>
        )}

        {status === "error" && <p className="tool-modal__error">{error}</p>}

        {status === "done" && result && (
          <div className="tool-modal__result">
            <span>Done — {result.filename}</span>
            <button type="button" className="tool-modal__download" onClick={handleDownload}>
              Download
            </button>
          </div>
        )}

        <div className="tool-modal__actions">
          <button type="button" className="tool-modal__cancel" onClick={onClose}>
            Close
          </button>
          <button type="button" className="tool-modal__run" disabled={!canRun} onClick={handleRun}>
            {status === "running" ? "Working…" : "Convert"}
          </button>
        </div>
      </div>
    </div>
  );
}

function defaultOptions(tool) {
  if (!tool) return {};
  const o = {};
  for (const f of tool.fields) o[f.key] = f.default;
  return o;
}
