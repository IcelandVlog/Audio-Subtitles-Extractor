import { useMemo } from "react";
import { parseSubtitle } from "./subtitleCore";

/** Parses subtitle text into cues, returning any error as data instead of via setState-in-render. */
export function useParsedCues(text, fileName) {
  return useMemo(() => {
    if (!text) return { cues: [], parseError: "" };
    try {
      const cues = parseSubtitle(text, fileName);
      if (cues.length === 0) {
        return { cues: [], parseError: "No cues found — is this a supported subtitle format?" };
      }
      return { cues, parseError: "" };
    } catch {
      return { cues: [], parseError: "Couldn't parse that file." };
    }
  }, [text, fileName]);
}
