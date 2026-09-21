import { useState } from "react";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";

export default function SupToSrt() {
  const [fileName, setFileName] = useState("");

  return (
    <ToolShell title="Sup to Srt Converter" description="Convert PGS (.sup) bitmap subtitles into text-based .srt." badge="Beta">
      <FileDrop onFile={(f) => setFileName(f.name)} accept=".sup" fileName={fileName} sub="or click to browse — .sup" />
      {fileName && (
        <p className="tool__hint">
          Got <span className="mono">{fileName}</span>. .sup subtitles are stored as images, not
          text, so turning them into .srt needs OCR on every frame. That engine isn't wired up
          yet in this build — for now, extract the audio/subtitle track with the tools on the
          home page, then run the .sup through a desktop OCR tool like Subtitle Edit.
        </p>
      )}
    </ToolShell>
  );
}
