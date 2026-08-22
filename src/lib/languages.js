// Small ISO 639-2 (and a few -1) code -> friendly name lookup. Falls back to the
// raw code itself when we don't recognise it (matches how most media players behave).
const LANGUAGE_NAMES = {
  eng: "English",
  en: "English",
  ara: "Arabic",
  ar: "Arabic",
  cze: "Czech",
  ces: "Czech",
  cs: "Czech",
  ger: "German",
  deu: "German",
  de: "German",
  spa: "Spanish",
  es: "Spanish",
  fre: "French",
  fra: "French",
  fr: "French",
  hin: "Hindi",
  hi: "Hindi",
  hun: "Hungarian",
  hu: "Hungarian",
  ind: "Indonesian",
  id: "Indonesian",
  ita: "Italian",
  it: "Italian",
  jpn: "Japanese",
  ja: "Japanese",
  kor: "Korean",
  ko: "Korean",
  pol: "Polish",
  pl: "Polish",
  por: "Portuguese",
  pt: "Portuguese",
  rus: "Russian",
  ru: "Russian",
  chi: "Chinese",
  zho: "Chinese",
  zh: "Chinese",
  tur: "Turkish",
  tr: "Turkish",
  vie: "Vietnamese",
  vi: "Vietnamese",
  tha: "Thai",
  th: "Thai",
  dut: "Dutch",
  nld: "Dutch",
  nl: "Dutch",
  swe: "Swedish",
  sv: "Swedish",
  nor: "Norwegian",
  no: "Norwegian",
  dan: "Danish",
  da: "Danish",
  fin: "Finnish",
  fi: "Finnish",
  gre: "Greek",
  ell: "Greek",
  el: "Greek",
  heb: "Hebrew",
  he: "Hebrew",
  ben: "Bengali",
  bn: "Bengali",
  ukr: "Ukrainian",
  uk: "Ukrainian",
  ron: "Romanian",
  rum: "Romanian",
  ro: "Romanian",
  und: null,
};

/** Friendly name for a 2/3-letter language code, or the raw code if unknown. */
export function languageName(code) {
  if (!code) return null;
  const key = code.toLowerCase();
  if (key in LANGUAGE_NAMES) return LANGUAGE_NAMES[key];
  return code;
}

/** Full row label, e.g. "English (eng)" or just "ben" when we don't know the name. */
export function languageLabel(code) {
  const name = languageName(code);
  if (!code) return "Unknown language";
  if (!name || name.toLowerCase() === code.toLowerCase()) return code;
  return `${name} (${code})`;
}
