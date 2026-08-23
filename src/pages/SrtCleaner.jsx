import { useMemo } from "react";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";
import { useTextFile } from "../lib/useTextFile";
import { useParsedCues } from "../lib/useParsedCues";
import { cleanCues, toSrt, toVtt } from "../lib/subtitleCore";
import { downloadBlob } from "../lib/download";

export default function SrtCleaner() {
  const { fileName, baseName, text, loadFile, error } = useTextFile();
  const { cues, parseError } = useParsedCues(text, fileName);

  const isVtt = fileName.toLowerCase().endsWith(".vtt");
  const cleaned = useMemo(() => cleanCues(cues), [cues]);
  const output = useMemo(() => (cleaned.length ? (isVtt ? toVtt(cleaned) : toSrt(cleaned)) : ""), [cleaned, isVtt]);
  const removedTags = useMemo(() => {
    return cues.reduce((n, c) => n + (c.text.match(/<[^>]+>|\{[^}]*\}/g) || []).length, 0);
  }, [cues]);

  return (
    <ToolShell
      title="Srt Cleaner"
      description="Strip out HTML tags, ASS override codes, and leftover formatting junk so the raw dialogue is left."
    >
      <FileDrop onFile={loadFile} accept=".srt,.vtt,.ass,.ssa,.sbv" fileName={fileName} sub="or click to browse — .srt, .vtt, .ass, .ssa, .sbv" />
      {error && <p className="tool__error">{error}</p>}
      {parseError && <p className="tool__error">{parseError}</p>}
      {cues.length > 0 && (
        <div className="tool__result">
          <p className="tool__hint">
            Removed {removedTags} formatting tag{removedTags === 1 ? "" : "s"} across {cues.length} cues.
          </p>
          <textarea className="tool__preview" readOnly value={output} rows={12} />
          <button
            type="button"
            className="btn btn--primary"
            onClick={() =>
              downloadBlob(new Blob([output], { type: "text/plain" }), `${baseName}-cleaned.${isVtt ? "vtt" : "srt"}`)
            }
          >
            Download cleaned {isVtt ? ".vtt" : ".srt"}
          </button>
        </div>
      )}
    </ToolShell>
  );
}
