import { useEffect, useMemo, useRef, useState } from "react";
import { downloadBlob, stripExt } from "../lib/download";
import { msToSrtTime } from "../lib/subtitle/formats";

function pad(n, len = 2) {
  return String(n).padStart(len, "0");
}

function msToLrcTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function fmtClock(ms) {
  if (ms == null) return "--:--.--";
  return msToLrcTime(ms);
}

export default function LyricsEditor({ onHome }) {
  const [audioUrl, setAudioUrl] = useState(null);
  const [audioName, setAudioName] = useState("");
  const [lines, setLines] = useState([]); // [{ id, text, time: ms|null }]
  const [rawText, setRawText] = useState("");
  const [cursor, setCursor] = useState(0); // index of the next untimed line to tag
  const audioRef = useRef(null);
  const fileInputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const handleAudioPick = (file) => {
    if (!file) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(URL.createObjectURL(file));
    setAudioName(file.name);
  };

  const handleLoadLines = () => {
    const parsed = rawText
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text, i) => ({ id: `l${i}-${Date.now()}`, text, time: null }));
    setLines(parsed);
    setCursor(0);
  };

  const nextUntimedIndex = useMemo(() => lines.findIndex((l) => l.time == null), [lines]);

  const tagLine = (index) => {
    const audio = audioRef.current;
    if (!audio || index < 0 || index >= lines.length) return;
    const ms = Math.round(audio.currentTime * 1000);
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, time: ms } : l)));
    setCursor(index + 1);
  };

  const handleTagNext = () => {
    const idx = nextUntimedIndex >= 0 ? nextUntimedIndex : lines.length - 1;
    tagLine(idx);
  };

  // spacebar taps the current line while the editor has focus (not while typing in a text field)
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== "Space") return;
      const tag = document.activeElement?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      e.preventDefault();
      handleTagNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector(".lyrics-row--current");
    active?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [cursor]);

  const updateLineText = (id, text) => {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, text } : l)));
  };

  const updateLineTime = (id, timeStr) => {
    // accepts mm:ss.xx
    const m = timeStr.match(/^(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$/);
    if (!m) return;
    const [, mm, ss, frac = "0"] = m;
    const ms = Number(mm) * 60000 + Number(ss) * 1000 + Number(frac.padEnd(3, "0").slice(0, 3));
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, time: ms } : l)));
  };

  const removeLine = (id) => {
    setLines((prev) => prev.filter((l) => l.id !== id));
  };

  const clearTimes = () => {
    setLines((prev) => prev.map((l) => ({ ...l, time: null })));
    setCursor(0);
  };

  const seekTo = (ms) => {
    if (audioRef.current && ms != null) {
      audioRef.current.currentTime = ms / 1000;
    }
  };

  const timedCount = lines.filter((l) => l.time != null).length;
  const allTimed = lines.length > 0 && timedCount === lines.length;

  const buildLrc = () => {
    const timed = lines.filter((l) => l.time != null).sort((a, b) => a.time - b.time);
    const header = audioName ? `[ti:${stripExt(audioName)}]\n` : "";
    const body = timed.map((l) => `[${msToLrcTime(l.time)}]${l.text}`).join("\n");
    return header + body + "\n";
  };

  const buildSrt = () => {
    const timed = lines.filter((l) => l.time != null).sort((a, b) => a.time - b.time);
    return timed
      .map((l, i) => {
        const end = timed[i + 1] ? timed[i + 1].time : l.time + 3000;
        return `${i + 1}\n${msToSrtTime(l.time)} --> ${msToSrtTime(end)}\n${l.text}`;
      })
      .join("\n\n")
      .concat("\n");
  };

  const handleDownloadLrc = () => {
    const base = audioName ? stripExt(audioName) : "lyrics";
    downloadBlob(new Blob([buildLrc()], { type: "text/plain" }), `${base}.lrc`);
  };

  const handleDownloadSrt = () => {
    const base = audioName ? stripExt(audioName) : "lyrics";
    downloadBlob(new Blob([buildSrt()], { type: "text/plain" }), `${base}.srt`);
  };

  return (
    <main className="shell">
      <section className="tool-page lyrics-editor">
        <button type="button" className="tool-page__back" onClick={onHome}>
          ← back to extractor
        </button>

        <p className="eyebrow">OTHER</p>
        <h1 className="tool-page__title">
          Timed Lyrics Editor
          <span className="tool-modal__beta">new</span>
        </h1>
        <p className="tool-page__hint">
          Load an audio file and your lyrics, then play the track and tag each line as it starts —
          export the result as a synced .lrc or .srt file.
        </p>

        <div className="lyrics-editor__audio">
          <div
            className="tool-modal__drop tool-page__drop"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files?.[0]) handleAudioPick(e.dataTransfer.files[0]);
            }}
            role="button"
            tabIndex={0}
          >
            <input
              ref={fileInputRef}
              type="file"
              hidden
              accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac"
              onChange={(e) => e.target.files?.[0] && handleAudioPick(e.target.files[0])}
            />
            {audioName ? <p>{audioName}</p> : <p>Drop an audio file here or click to browse</p>}
          </div>

          {audioUrl && (
            <audio
              ref={audioRef}
              src={audioUrl}
              controls
              className="lyrics-editor__player"
            />
          )}
        </div>

        {lines.length === 0 ? (
          <div className="tool-modal__fields lyrics-editor__paste">
            <label className="tool-modal__field">
              <span>Paste your lyrics — one line per row</span>
              <textarea
                className="lyrics-editor__textarea"
                rows={10}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder={"First line of the song\nSecond line\nThird line…"}
              />
            </label>
            <div className="tool-modal__actions">
              <button type="button" className="tool-modal__run" disabled={!rawText.trim()} onClick={handleLoadLines}>
                Load lines
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="lyrics-editor__toolbar">
              <button
                type="button"
                className="tool-modal__run"
                disabled={!audioUrl || allTimed}
                onClick={handleTagNext}
              >
                Tag current line ({timedCount}/{lines.length})
              </button>
              <span className="lyrics-editor__hint">or press space while the player is focused elsewhere</span>
              <button type="button" className="tool-modal__cancel" onClick={clearTimes}>
                Clear times
              </button>
            </div>

            <div className="lyrics-editor__list" ref={listRef}>
              {lines.map((l, i) => (
                <div
                  key={l.id}
                  className={`lyrics-row ${i === nextUntimedIndex ? "lyrics-row--current" : ""}`}
                >
                  <button
                    type="button"
                    className="lyrics-row__time"
                    onClick={() => (l.time != null ? seekTo(l.time) : tagLine(i))}
                    title={l.time != null ? "Seek to this time" : "Tag this line at the current playhead"}
                  >
                    {fmtClock(l.time)}
                  </button>
                  <input
                    type="text"
                    className="lyrics-row__text"
                    value={l.text}
                    onChange={(e) => updateLineText(l.id, e.target.value)}
                  />
                  <input
                    type="text"
                    className="lyrics-row__timeinput"
                    placeholder="mm:ss.xx"
                    defaultValue={l.time != null ? fmtClock(l.time) : ""}
                    onBlur={(e) => e.target.value && updateLineTime(l.id, e.target.value.trim())}
                  />
                  <button type="button" className="lyrics-row__remove" onClick={() => removeLine(l.id)} aria-label="Remove line">
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <div className="tool-modal__actions">
              <button type="button" className="tool-modal__cancel" onClick={() => setLines([])}>
                Start over
              </button>
              <button type="button" className="tool-modal__download" disabled={timedCount === 0} onClick={handleDownloadLrc}>
                Download .lrc
              </button>
              <button type="button" className="tool-modal__download" disabled={timedCount === 0} onClick={handleDownloadSrt}>
                Download .srt
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
