import { useMemo } from "react";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";
import { useTextFile } from "../lib/useTextFile";
import { useParsedCues } from "../lib/useParsedCues";
import { toPlainText } from "../lib/subtitleCore";
import { downloadBlob } from "../lib/download";

export default function ConvertToText() {
  const { fileName, baseName, text, loadFile, error } = useTextFile();
  const { cues, parseError } = useParsedCues(text, fileName);
  const output = useMemo(() => (cues.length ? toPlainText(cues) : ""), [cues]);

  return (
    <ToolShell
      title="Convert to Plain Text"
      description="Strip out timestamps and formatting, leaving just the dialogue — one line per cue."
    >
      <FileDrop
        onFile={loadFile}
        accept=".srt,.vtt,.ass,.ssa,.sbv"
        fileName={fileName}
        sub="or click to browse — .srt, .vtt, .ass, .ssa, .sbv"
      />
      {error && <p className="tool__error">{error}</p>}
      {parseError && <p className="tool__error">{parseError}</p>}
      {output && (
        <div className="tool__result">
          <textarea className="tool__preview" readOnly value={output} rows={12} />
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => downloadBlob(new Blob([output], { type: "text/plain" }), `${baseName}.txt`)}
          >
            Download .txt
          </button>
        </div>
      )}
    </ToolShell>
  );
}
