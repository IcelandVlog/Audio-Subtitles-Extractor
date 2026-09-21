import { useMemo, useState } from "react";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";
import { useTextFile } from "../lib/useTextFile";
import { useParsedCues } from "../lib/useParsedCues";
import { positionCuesVtt, toVttWithPosition } from "../lib/subtitleCore";
import { downloadBlob } from "../lib/download";

const POSITIONS = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];

export default function PositionChanger() {
  const { fileName, baseName, text, loadFile, error } = useTextFile();
  const { cues, parseError } = useParsedCues(text, fileName);
  const [position, setPosition] = useState("bottom-center");

  const output = useMemo(
    () => (cues.length ? toVttWithPosition(positionCuesVtt(cues, position)) : ""),
    [cues, position]
  );

  return (
    <ToolShell
      title="Position changer"
      description="Move subtitles to a different spot on screen — exports as .vtt, since .srt has no standard position field."
    >
      <FileDrop onFile={loadFile} accept=".srt,.vtt,.ass,.ssa,.sbv" fileName={fileName} sub="or click to browse — .srt, .vtt, .ass, .ssa, .sbv" />
      {error && <p className="tool__error">{error}</p>}
      {parseError && <p className="tool__error">{parseError}</p>}
      {cues.length > 0 && (
        <div className="tool__result">
          <div className="position-grid">
            {POSITIONS.map((p) => (
              <button
                key={p}
                type="button"
                className={`position-grid__cell ${position === p ? "position-grid__cell--active" : ""}`}
                onClick={() => setPosition(p)}
                aria-label={p}
              />
            ))}
          </div>
          <p className="tool__hint">Position: {position.replace("-", " ")}</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => downloadBlob(new Blob([output], { type: "text/vtt" }), `${baseName}-positioned.vtt`)}
          >
            Download .vtt
          </button>
        </div>
      )}
    </ToolShell>
  );
}
