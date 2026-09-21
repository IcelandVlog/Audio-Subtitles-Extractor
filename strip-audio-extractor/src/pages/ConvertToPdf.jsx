import { useState } from "react";
import { jsPDF } from "jspdf";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";
import { useTextFile } from "../lib/useTextFile";
import { useParsedCues } from "../lib/useParsedCues";
import { msToSrtTime } from "../lib/subtitleCore";

export default function ConvertToPdf() {
  const { fileName, baseName, text, loadFile, error } = useTextFile();
  const { cues, parseError: convertError } = useParsedCues(text, fileName);
  const [includeTimes, setIncludeTimes] = useState(true);

  const handleDownload = () => {
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const marginX = 48;
    let y = 56;
    const pageH = doc.internal.pageSize.getHeight();
    const pageW = doc.internal.pageSize.getWidth();
    const maxWidth = pageW - marginX * 2;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(baseName || "subtitles", marginX, y);
    y += 24;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);

    for (const c of cues) {
      if (includeTimes) {
        doc.setTextColor(140);
        doc.setFontSize(9);
        doc.text(`${msToSrtTime(c.start)} --> ${msToSrtTime(c.end)}`, marginX, y);
        y += 13;
        doc.setFontSize(11);
        doc.setTextColor(20);
      }
      const lines = doc.splitTextToSize(c.text.replace(/<[^>]+>/g, ""), maxWidth);
      for (const line of lines) {
        if (y > pageH - 48) {
          doc.addPage();
          y = 56;
        }
        doc.text(line, marginX, y);
        y += 15;
      }
      y += 10;
      if (y > pageH - 48) {
        doc.addPage();
        y = 56;
      }
    }
    doc.save(`${baseName}.pdf`);
  };

  return (
    <ToolShell
      title="Convert to PDF"
      description="Turn a subtitle file into a clean, readable PDF transcript — handy for scripts and proofreading."
    >
      <FileDrop
        onFile={loadFile}
        accept=".srt,.vtt,.ass,.ssa,.sbv"
        fileName={fileName}
        sub="or click to browse — .srt, .vtt, .ass, .ssa, .sbv"
      />
      {error && <p className="tool__error">{error}</p>}
      {convertError && <p className="tool__error">{convertError}</p>}
      {cues.length > 0 && (
        <div className="tool__result">
          <label className="tool__checkbox">
            <input
              type="checkbox"
              checked={includeTimes}
              onChange={(e) => setIncludeTimes(e.target.checked)}
            />
            Include timestamps
          </label>
          <p className="tool__hint">{cues.length} cues ready.</p>
          <button type="button" className="btn btn--primary" onClick={handleDownload}>
            Download .pdf
          </button>
        </div>
      )}
    </ToolShell>
  );
}
