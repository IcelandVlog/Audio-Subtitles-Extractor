import { useMemo } from "react";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";
import { useTextFile } from "../lib/useTextFile";
import { useParsedCues } from "../lib/useParsedCues";
import { mergeCueLists, toSrt } from "../lib/subtitleCore";
import { downloadBlob } from "../lib/download";

export default function SubtitleMerger() {
  const trackA = useTextFile();
  const trackB = useTextFile();
  const { cues: cuesA, parseError: errorA } = useParsedCues(trackA.text, trackA.fileName);
  const { cues: cuesB, parseError: errorB } = useParsedCues(trackB.text, trackB.fileName);

  const merged = useMemo(() => {
    if (cuesA.length === 0 || cuesB.length === 0) return [];
    return mergeCueLists(cuesA, cuesB);
  }, [cuesA, cuesB]);

  const output = useMemo(() => (merged.length ? toSrt(merged) : ""), [merged]);
  const mergeError = trackA.text && trackB.text && merged.length === 0 && !errorA && !errorB
    ? "Couldn't find cues in one of the files."
    : "";

  return (
    <ToolShell
      title="Subtitle Merger"
      description="Combine two subtitle tracks into one dual-language .srt — overlapping cues are stacked on top of each other."
    >
      <div className="tool__row tool__row--stack">
        <div>
          <p className="tool__label">Track A (shown first)</p>
          <FileDrop onFile={trackA.loadFile} accept=".srt,.vtt,.ass,.ssa,.sbv" fileName={trackA.fileName} />
        </div>
        <div>
          <p className="tool__label">Track B (shown second)</p>
          <FileDrop onFile={trackB.loadFile} accept=".srt,.vtt,.ass,.ssa,.sbv" fileName={trackB.fileName} />
        </div>
      </div>
      {(trackA.error || trackB.error) && <p className="tool__error">{trackA.error || trackB.error}</p>}
      {(errorA || errorB || mergeError) && <p className="tool__error">{errorA || errorB || mergeError}</p>}
      {merged.length > 0 && (
        <div className="tool__result">
          <p className="tool__hint">{merged.length} merged cues.</p>
          <textarea className="tool__preview" readOnly value={output} rows={12} />
          <button
            type="button"
            className="btn btn--primary"
            onClick={() =>
              downloadBlob(new Blob([output], { type: "text/plain" }), `${trackA.baseName || "merged"}-merged.srt`)
            }
          >
            Download merged .srt
          </button>
        </div>
      )}
    </ToolShell>
  );
}
