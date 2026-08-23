import { useState } from "react";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";

export default function SubIdxToSrt() {
  const [files, setFiles] = useState([]);

  const handleFile = (f) => setFiles((prev) => [...prev.filter((p) => p.name !== f.name), f]);

  return (
    <ToolShell
      title="Sub/Idx to Srt Converter"
      description="Convert VobSub (.sub + .idx) bitmap subtitles into text-based .srt."
      badge="Beta"
    >
      <FileDrop onFile={handleFile} accept=".sub,.idx" fileName={files.map((f) => f.name).join(", ")} sub="or click to browse — add both .sub and .idx" />
      {files.length > 0 && (
        <p className="tool__hint">
          Got {files.map((f) => f.name).join(" + ")}. VobSub tracks are bitmap images keyed by
          the .idx timing file, so — like .sup — text extraction needs an OCR pass per frame.
          That's not wired up in this build yet. Subtitle Edit or SubRip on desktop can do this
          conversion in the meantime.
        </p>
      )}
    </ToolShell>
  );
}
