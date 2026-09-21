import { useMemo } from "react";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";
import { useTextFile } from "../lib/useTextFile";
import { useParsedCues } from "../lib/useParsedCues";
import { toVtt } from "../lib/subtitleCore";
import { downloadBlob } from "../lib/download";

export default function ConvertToVtt() {
  const { fileName, baseName, text, loadFile, error } = useTextFile();
  const { cues, parseError } = useParsedCues(text, fileName);
  const output = useMemo(() => (cues.length ? toVtt(cues) : ""), [cues]);

  return (
    <ToolShell
      title="Convert to WebVtt"
      description="Turn Srt, ASS/SSA, or SubViewer subtitles into a browser-ready .vtt file."
    >
      <FileDrop
        onFile={loadFile}
        accept=".srt,.ass,.ssa,.sbv,.vtt,.txt"
        fileName={fileName}
        sub="or click to browse — .srt, .ass, .ssa, .sbv"
      />
      {error && <p className="tool__error">{error}</p>}
      {parseError && <p className="tool__error">{parseError}</p>}
      {output && (
        <div className="tool__result">
          <textarea className="tool__preview" readOnly value={output} rows={12} />
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => downloadBlob(new Blob([output], { type: "text/vtt" }), `${baseName}.vtt`)}
          >
            Download .vtt
          </button>
        </div>
      )}
    </ToolShell>
  );
}
