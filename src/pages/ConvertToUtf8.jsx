import { useState } from "react";
import ToolShell from "../components/ToolShell";
import FileDrop from "../components/FileDrop";
import { useTextFile } from "../lib/useTextFile";
import { downloadBlob, stripExt } from "../lib/download";

const ENCODINGS = [
  { value: "windows-1252", label: "Windows-1252 (Western Europe)" },
  { value: "iso-8859-1", label: "ISO-8859-1 (Latin-1)" },
  { value: "windows-1251", label: "Windows-1251 (Cyrillic)" },
  { value: "gbk", label: "GBK (Simplified Chinese)" },
  { value: "big5", label: "Big5 (Traditional Chinese)" },
  { value: "shift-jis", label: "Shift-JIS (Japanese)" },
  { value: "euc-kr", label: "EUC-KR (Korean)" },
  { value: "windows-1256", label: "Windows-1256 (Arabic)" },
  { value: "windows-1253", label: "Windows-1253 (Greek)" },
  { value: "iso-8859-9", label: "ISO-8859-9 (Turkish)" },
];

export default function ConvertToUtf8() {
  const { fileName, text, loadFile, error } = useTextFile();
  const [sourceEncoding, setSourceEncoding] = useState("windows-1252");
  const [rawFile, setRawFile] = useState(null);

  const handleFile = (file) => {
    setRawFile(file);
    loadFile(file, "utf-8"); // initial pass just to grab the name/preview attempt
  };

  const handleReencode = () => {
    if (!rawFile) return;
    const reader = new FileReader();
    reader.onload = () => {
      const decoder = new TextDecoder(sourceEncoding);
      const content = decoder.decode(reader.result);
      const blob = new Blob(["\uFEFF" + content], { type: "text/plain;charset=utf-8" });
      downloadBlob(blob, `${stripExt(fileName)}-utf8${fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ".srt"}`);
    };
    reader.readAsArrayBuffer(rawFile);
  };

  return (
    <ToolShell
      title="Convert to UTF-8"
      description="Re-encode a subtitle file that's showing garbled characters (mojibake) into clean UTF-8."
    >
      <FileDrop onFile={handleFile} accept=".srt,.vtt,.ass,.ssa,.sbv,.txt" fileName={fileName} sub="or click to browse — any subtitle text file" />
      {error && <p className="tool__error">{error}</p>}
      {rawFile && (
        <div className="tool__result">
          <label className="tool__row">
            Source encoding
            <select value={sourceEncoding} onChange={(e) => setSourceEncoding(e.target.value)}>
              {ENCODINGS.map((enc) => (
                <option key={enc.value} value={enc.value}>
                  {enc.label}
                </option>
              ))}
            </select>
          </label>
          <p className="tool__hint">
            Pick the encoding the original file was saved in (if you're not sure, try a couple —
            you'll see garbled text immediately if it's wrong), then convert.
          </p>
          <button type="button" className="btn btn--primary" onClick={handleReencode}>
            Convert &amp; download as UTF-8
          </button>
          {text && (
            <textarea className="tool__preview" readOnly value={text.slice(0, 2000)} rows={8} />
          )}
        </div>
      )}
    </ToolShell>
  );
}
