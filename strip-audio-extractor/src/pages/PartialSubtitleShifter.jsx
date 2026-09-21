import { useMemo, useState } from "react";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";
import { useTextFile } from "../lib/useTextFile";
import { useParsedCues } from "../lib/useParsedCues";
import { partialShiftCues, timeToMs, msToSrtTime, toSrt, toVtt } from "../lib/subtitleCore";
import { downloadBlob } from "../lib/download";

export default function PartialSubtitleShifter() {
  const { fileName, baseName, text, loadFile, error } = useTextFile();
  const { cues, parseError } = useParsedCues(text, fileName);
  const [fromTime, setFromTime] = useState("00:00:00");
  const [seconds, setSeconds] = useState(0);
  const [milliseconds, setMilliseconds] = useState(0);
  const [direction, setDirection] = useState("later");

  const fromMs = timeToMs(fromTime || "0");
  const deltaMs = (direction === "later" ? 1 : -1) * (Number(seconds) * 1000 + Number(milliseconds));
  const isVtt = fileName.toLowerCase().endsWith(".vtt");
  const shifted = useMemo(() => partialShiftCues(cues, fromMs, deltaMs), [cues, fromMs, deltaMs]);
  const affectedCount = cues.filter((c) => c.start >= fromMs).length;

  const handleDownload = () => {
    const out = isVtt ? toVtt(shifted) : toSrt(shifted);
    const ext = isVtt ? "vtt" : "srt";
    downloadBlob(new Blob([out], { type: "text/plain" }), `${baseName}-partial-shifted.${ext}`);
  };

  return (
    <ToolShell
      title="Partial Subtitle Shifter"
      description="Shift only the cues from a chosen point onward — for tracks that drift out of sync partway through."
    >
      <FileDrop onFile={loadFile} accept=".srt,.vtt,.ass,.ssa,.sbv" fileName={fileName} sub="or click to browse — .srt, .vtt, .ass, .ssa, .sbv" />
      {error && <p className="tool__error">{error}</p>}
      {parseError && <p className="tool__error">{parseError}</p>}
      {cues.length > 0 && (
        <div className="tool__result">
          <div className="tool__row">
            <label>
              Shift from
              <input type="text" value={fromTime} onChange={(e) => setFromTime(e.target.value)} placeholder="00:12:30" />
            </label>
            <label>
              Direction
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
              Ms
              <input type="number" min="0" max="999" value={milliseconds} onChange={(e) => setMilliseconds(e.target.value)} />
            </label>
          </div>
          <p className="tool__hint">
            {affectedCount} of {cues.length} cues (from {msToSrtTime(fromMs)} onward) will shift by{" "}
            {deltaMs >= 0 ? "+" : ""}
            {deltaMs}ms.
          </p>
          <button type="button" className="btn btn--primary" onClick={handleDownload}>
            Download shifted {isVtt ? ".vtt" : ".srt"}
          </button>
        </div>
      )}
    </ToolShell>
  );
}
