import { pinyin } from "pinyin-pro";

const TONE_TYPE = {
  marks: "symbol", // nǐ hǎo
  numbers: "num", // ni3 hao3
  none: "none", // ni hao
};

/** Converts a single line of (possibly mixed) text to Pinyin, leaving non-Chinese runs untouched. */
export function lineToPinyin(text, tone = "marks") {
  return pinyin(text, {
    toneType: TONE_TYPE[tone] || "symbol",
    type: "string",
    nonZh: "consecutive",
  });
}

/**
 * mode: "bilingual" keeps the original line and adds a Pinyin line beneath it,
 * "pinyin" replaces the line with Pinyin only.
 */
export function cuesToPinyin(cues, { mode = "bilingual", tone = "marks" } = {}) {
  return cues.map((c) => {
    const converted = c.text
      .split("\n")
      .map((line) => lineToPinyin(line, tone))
      .join("\n");
    if (mode === "pinyin") {
      return { ...c, text: converted };
    }
    return { ...c, text: `${c.text}\n${converted}` };
  });
}
