import { useMemo, useState } from "react";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";
import { useTextFile } from "../lib/useTextFile";
import { useParsedCues } from "../lib/useParsedCues";
import { colorizeCues, toSrt } from "../lib/subtitleCore";
import { downloadBlob } from "../lib/download";

export default function ColorChanger() {
  const { fileName, baseName, text, loadFile, error } = useTextFile();
  const { cues, parseError } = useParsedCues(text, fileName);
  const [color, setColor] = useState("#ffe066");

  const output = useMemo(() => (cues.length ? toSrt(colorizeCues(cues, color)) : ""), [cues, color]);

  return (
    <ToolShell
      title="Color changer"
      description="Wrap every subtitle line in an <font color> tag — supported by most players for .srt."
    >
      <FileDrop onFile={loadFile} accept=".srt,.vtt,.ass,.ssa,.sbv" fileName={fileName} sub="or click to browse — .srt, .vtt, .ass, .ssa, .sbv" />
      {error && <p className="tool__error">{error}</p>}
      {parseError && <p className="tool__error">{parseError}</p>}
      {cues.length > 0 && (
        <div className="tool__result">
          <label className="tool__row">
            Text color
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            <span className="mono">{color}</span>
          </label>
          <p className="tool__preview-line" style={{ color }}>
            {cues[0]?.text.split("\n")[0] || "Sample subtitle text"}
          </p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => downloadBlob(new Blob([output], { type: "text/plain" }), `${baseName}-colored.srt`)}
          >
            Download colored .srt
          </button>
        </div>
      )}
    </ToolShell>
  );
}
