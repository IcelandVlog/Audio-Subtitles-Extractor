import { useMemo, useState } from "react";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";
import { useTextFile } from "../lib/useTextFile";
import { useParsedCues } from "../lib/useParsedCues";
import { shiftCues, toSrt, toVtt } from "../lib/subtitleCore";
import { downloadBlob } from "../lib/download";

export default function SubtitleShifter() {
  const { fileName, baseName, text, loadFile, error } = useTextFile();
  const { cues, parseError } = useParsedCues(text, fileName);
  const [seconds, setSeconds] = useState(0);
  const [milliseconds, setMilliseconds] = useState(0);
  const [direction, setDirection] = useState("later");

  const deltaMs = (direction === "later" ? 1 : -1) * (Number(seconds) * 1000 + Number(milliseconds));
  const isVtt = fileName.toLowerCase().endsWith(".vtt");
  const shifted = useMemo(() => shiftCues(cues, deltaMs), [cues, deltaMs]);

  const handleDownload = () => {
    const out = isVtt ? toVtt(shifted) : toSrt(shifted);
    const ext = isVtt ? "vtt" : "srt";
    downloadBlob(new Blob([out], { type: "text/plain" }), `${baseName}-shifted.${ext}`);
  };

  return (
    <ToolShell
      title="Subtitle Shifter"
      description="Move every subtitle earlier or later by a fixed amount — fixes a track that's out of sync from start to end."
    >
      <FileDrop onFile={loadFile} accept=".srt,.vtt,.ass,.ssa,.sbv" fileName={fileName} sub="or click to browse — .srt, .vtt, .ass, .ssa, .sbv" />
      {error && <p className="tool__error">{error}</p>}
      {parseError && <p className="tool__error">{parseError}</p>}
      {cues.length > 0 && (
        <div className="tool__result">
          <div className="tool__row">
            <label>
              Shift
              <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                <option value="later">later (+)</option>
                <option value="earlier">earlier (−)</option>
              </select>
            </label>
            <label>
              Seconds
              <input type="number" min="0" value={seconds} onChange={(e) => setSeconds(e.target.value)} />
            </label>
            <label>
              Milliseconds
              <input type="number" min="0" max="999" value={milliseconds} onChange={(e) => setMilliseconds(e.target.value)} />
            </label>
          </div>
          <p className="tool__hint">
            Applying {deltaMs >= 0 ? "+" : ""}
            {deltaMs}ms to {cues.length} cues.
          </p>
          <button type="button" className="btn btn--primary" onClick={handleDownload}>
            Download shifted {isVtt ? ".vtt" : ".srt"}
          </button>
        </div>
      )}
    </ToolShell>
  );
}
