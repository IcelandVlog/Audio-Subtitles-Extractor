import { jsPDF } from "jspdf";
import { msToSrtTime } from "./formats";
import { stripTags } from "./tools";

export function cuesToPdfBlob(cues, title = "Subtitles") {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 48;
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(title, margin, y);
  y += 28;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);

  for (const cue of cues) {
    const timeLine = `${msToSrtTime(cue.start)} \u2192 ${msToSrtTime(cue.end)}`;
    const bodyLines = doc.splitTextToSize(stripTags(cue.text), maxWidth);
    const blockHeight = 16 + bodyLines.length * 14 + 10;

    if (y + blockHeight > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }

    doc.setTextColor(120);
    doc.setFontSize(9);
    doc.text(timeLine, margin, y);
    y += 14;

    doc.setTextColor(20);
    doc.setFontSize(11);
    doc.text(bodyLines, margin, y);
    y += bodyLines.length * 14 + 10;
  }

  return doc.output("blob");
}
