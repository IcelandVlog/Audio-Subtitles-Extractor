import { useCallback, useRef, useState } from "react";

export default function FileDrop({ onFile, accept, label, sub, fileName }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files?.[0];
      if (f) onFile(f);
    },
    [onFile]
  );

  return (
    <div
      className={`dropzone dropzone--tool ${dragging ? "dropzone--active" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      <div className="dropzone__mark">⇩</div>
      <p className="dropzone__title">{fileName || label || "Drop a file here"}</p>
      <p className="dropzone__sub">{sub || "or click to browse"}</p>
    </div>
  );
}
