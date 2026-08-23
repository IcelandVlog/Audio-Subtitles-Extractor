import { useCallback, useState } from "react";
import { stripExt } from "./download";

export function useTextFile() {
  const [fileName, setFileName] = useState("");
  const [baseName, setBaseName] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const loadFile = useCallback((file, encoding = "utf-8") => {
    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const decoder = new TextDecoder(encoding);
        const content = decoder.decode(reader.result);
        setText(content);
        setFileName(file.name);
        setBaseName(stripExt(file.name));
      } catch {
        setError(`Couldn't decode this file as ${encoding}. Try a different encoding.`);
      }
    };
    reader.onerror = () => setError("Couldn't read that file.");
    reader.readAsArrayBuffer(file);
  }, []);

  return { fileName, baseName, text, setText, loadFile, error, setError };
}
