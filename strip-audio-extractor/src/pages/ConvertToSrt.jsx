import { useMemo } from "react";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";
import { useTextFile } from "../lib/useTextFile";
import { useParsedCues } from "../lib/useParsedCues";
import { toSrt } from "../lib/subtitleCore";
import { downloadBlob } from "../lib/download";

export default function ConvertToSrt() {
  const { fileName, baseName, text, loadFile, error } = useTextFile();
  const { cues, parseError } = useParsedCues(text, fileName);
  const output = useMemo(() => (cues.length ? toSrt(cues) : ""), [cues]);

  return (
    <ToolShell
      title="Convert to Srt"
      description="Turn WebVTT, ASS/SSA, or SubViewer subtitles into a standard .srt file."
    >
      <FileDrop
        onFile={loadFile}
        accept=".vtt,.ass,.ssa,.sbv,.srt,.txt"
        fileName={fileName}
        sub="or click to browse — .vtt, .ass, .ssa, .sbv"
      />
      {error && <p className="tool__error">{error}</p>}
      {parseError && <p className="tool__error">{parseError}</p>}
      {output && (
        <div className="tool__result">
          <textarea className="tool__preview" readOnly value={output} rows={12} />
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => downloadBlob(new Blob([output], { type: "text/plain" }), `${baseName}.srt`)}
          >
            Download .srt
          </button>
        </div>
      )}
    </ToolShell>
  );
}
