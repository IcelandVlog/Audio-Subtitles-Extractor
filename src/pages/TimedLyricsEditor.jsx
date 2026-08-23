import { useMemo, useRef, useState } from "react";
import ToolShell from "../components/ToolShell";
import { msToSrtTime, toSrt } from "../lib/subtitleCore";
import { downloadBlob } from "../lib/download";

export default function TimedLyricsEditor() {
  const [audioUrl, setAudioUrl] = useState("");
  const [audioName, setAudioName] = useState("");
  const [lyricsText, setLyricsText] = useState("");
  const [marks, setMarks] = useState([]); // ms timestamps, one per non-empty lyric line
  const audioRef = useRef(null);

  const lines = useMemo(
    () => lyricsText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
    [lyricsText]
  );

  const handleAudioFile = (file) => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(URL.createObjectURL(file));
    setAudioName(file.name);
    setMarks([]);
  };

  const currentLineIndex = marks.length;

  const markCurrentTime = () => {
    if (!audioRef.current || currentLineIndex >= lines.length) return;
    const ms = Math.round(audioRef.current.currentTime * 1000);
    setMarks((prev) => [...prev, ms]);
  };

  const undoMark = () => setMarks((prev) => prev.slice(0, -1));
  const resetMarks = () => setMarks([]);

  const cues = useMemo(() => {
    return marks.map((start, i) => ({
      index: i + 1,
      start,
      end: marks[i + 1] != null ? marks[i + 1] : start + 3000,
      text: lines[i],
    }));
  }, [marks, lines]);

  const handleDownload = () => {
    const out = toSrt(cues);
    downloadBlob(new Blob([out], { type: "text/plain" }), `${(audioName || "lyrics").replace(/\.[^.]+$/, "")}.srt`);
  };

  return (
    <ToolShell
      title="Timed Lyrics Editor"
      description="Load a song, paste the lyrics, and tap along as it plays to build a synced .srt — a manual, ear-driven way to time a track."
      badge="New!"
    >
      <div className="lyrics-editor">
        <div className="lyrics-editor__col">
          <p className="tool__label">1. Load audio</p>
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => e.target.files?.[0] && handleAudioFile(e.target.files[0])}
          />
          {audioUrl && <audio ref={audioRef} src={audioUrl} controls className="lyrics-editor__audio" />}

          <p className="tool__label">2. Paste lyrics (one line per cue)</p>
          <textarea
            className="tool__preview"
            rows={10}
            value={lyricsText}
            onChange={(e) => setLyricsText(e.target.value)}
            placeholder={"Line one\nLine two\nLine three…"}
          />
        </div>

        <div className="lyrics-editor__col">
          <p className="tool__label">3. Play the audio, tap Mark on each line</p>
          <div className="lyrics-editor__current">
            {currentLineIndex < lines.length
              ? lines[currentLineIndex]
              : lines.length === 0
              ? "Paste lyrics to begin"
              : "All lines timed ✓"}
          </div>
          <div className="tool__row">
            <button type="button" className="btn btn--primary" onClick={markCurrentTime} disabled={!audioUrl || currentLineIndex >= lines.length}>
              Mark ⏱
            </button>
            <button type="button" className="btn" onClick={undoMark} disabled={marks.length === 0}>
              Undo
            </button>
            <button type="button" className="btn" onClick={resetMarks} disabled={marks.length === 0}>
              Reset
            </button>
          </div>

          <p className="tool__label">Timed so far ({marks.length}/{lines.length})</p>
          <ul className="lyrics-editor__list">
            {cues.map((c) => (
              <li key={c.index}>
                <span className="mono">{msToSrtTime(c.start)}</span> {c.text}
              </li>
            ))}
          </ul>

          {cues.length > 0 && (
            <button type="button" className="btn btn--primary" onClick={handleDownload}>
              Download .srt
            </button>
          )}
        </div>
      </div>
    </ToolShell>
  );
}
