import { useCallback, useRef, useState } from "react";

export default function Dropzone({ onFiles, engineState }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
    },
    [onFiles]
  );

  return (
    <div
      className={`dropzone ${dragging ? "dropzone--active" : ""}`}
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
        accept="video/*,.mp4,.mov,.mkv,.avi,.flv,.webm,.m4v,.wmv"
        multiple
        hidden
        onChange={(e) => e.target.files?.length && onFiles(e.target.files)}
      />
      <div className="dropzone__mark">⇩</div>
      <p className="dropzone__title">Drop video files here</p>
      <p className="dropzone__sub">or click to browse — mp4, mov, mkv, avi, flv, webm</p>
      <p className="dropzone__note">
        {engineState === "loading"
          ? "Warming up the engine…"
          : engineState === "error"
          ? "Engine didn't load — try adding the file again."
          : "Runs entirely in this tab. Nothing leaves your device."}
      </p>
    </div>
  );
}
