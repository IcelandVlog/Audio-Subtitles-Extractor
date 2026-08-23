import { useMemo, useState } from "react";
import { pinyin } from "pinyin-pro";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";
import { useTextFile } from "../lib/useTextFile";
import { useParsedCues } from "../lib/useParsedCues";
import { toSrt } from "../lib/subtitleCore";
import { downloadBlob } from "../lib/download";

export default function PinyinSubtitles() {
  const { fileName, baseName, text, loadFile, error } = useTextFile();
  const { cues, parseError } = useParsedCues(text, fileName);
  const [mode, setMode] = useState("above"); // above | replace

  const converted = useMemo(() => {
    return cues.map((c) => {
      const lines = c.text.split("\n").map((line) => {
        const py = pinyin(line, { toneType: "symbol", type: "string" });
        if (mode === "replace") return py;
        return `${py}\n${line}`;
      });
      return { ...c, text: lines.join("\n") };
    });
  }, [cues, mode]);

  const output = useMemo(() => (converted.length ? toSrt(converted) : ""), [converted]);

  return (
    <ToolShell
      title="Make Pinyin Subtitles"
      description="Add Hanyu Pinyin above (or in place of) Chinese subtitle text — helpful for language learners."
    >
      <FileDrop onFile={loadFile} accept=".srt,.vtt,.ass,.ssa,.sbv" fileName={fileName} sub="or click to browse — .srt, .vtt, .ass, .ssa, .sbv" />
      {error && <p className="tool__error">{error}</p>}
      {parseError && <p className="tool__error">{parseError}</p>}
      {cues.length > 0 && (
        <div className="tool__result">
          <label className="tool__row">
            Style
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="above">Pinyin above Chinese</option>
              <option value="replace">Pinyin only (replace)</option>
            </select>
          </label>
          <textarea className="tool__preview" readOnly value={output} rows={12} />
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => downloadBlob(new Blob([output], { type: "text/plain" }), `${baseName}-pinyin.srt`)}
          >
            Download .srt
          </button>
        </div>
      )}
    </ToolShell>
  );
}
