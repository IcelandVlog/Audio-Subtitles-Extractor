import { francAll } from "franc";

// franc identifies text by trigram/script analysis — no model download, works
// instantly, and covers 150+ languages (vs. Whisper's 99), which is exactly
// what text-based subtitle detection needs: we already have the dialogue as
// text, so there's no reason to reach for audio/ML here.
//
// It reports ISO 639-3 codes. We map the common ones to a friendly name and,
// where one exists, the shorter ISO 639-1 code that media players (Plex,
// Jellyfin, Kodi, VLC, ...) expect in filenames like `movie.bn.srt`. Codes we
// don't recognise still work fine — we just fall back to showing/using the
// raw 639-3 code, which is itself a valid (if less common) filename tag.
const ISO_639_3 = {
  eng: ["en", "English"],
  cmn: ["zh", "Chinese (Mandarin)"],
  spa: ["es", "Spanish"],
  rus: ["ru", "Russian"],
  arb: ["ar", "Arabic"],
  ben: ["bn", "Bengali"],
  hin: ["hi", "Hindi"],
  por: ["pt", "Portuguese"],
  ind: ["id", "Indonesian"],
  jpn: ["ja", "Japanese"],
  fra: ["fr", "French"],
  deu: ["de", "German"],
  jav: ["jw", "Javanese"],
  kor: ["ko", "Korean"],
  tel: ["te", "Telugu"],
  vie: ["vi", "Vietnamese"],
  mar: ["mr", "Marathi"],
  ita: ["it", "Italian"],
  tam: ["ta", "Tamil"],
  tur: ["tr", "Turkish"],
  urd: ["ur", "Urdu"],
  guj: ["gu", "Gujarati"],
  pol: ["pl", "Polish"],
  ukr: ["uk", "Ukrainian"],
  kan: ["kn", "Kannada"],
  mai: [null, "Maithili"],
  mal: ["ml", "Malayalam"],
  pes: ["fa", "Persian"],
  prs: ["fa", "Dari Persian"],
  mya: ["my", "Burmese"],
  swh: ["sw", "Swahili"],
  sun: ["su", "Sundanese"],
  ron: ["ro", "Romanian"],
  pan: ["pa", "Punjabi"],
  bho: [null, "Bhojpuri"],
  amh: ["am", "Amharic"],
  hau: ["ha", "Hausa"],
  bos: ["bs", "Bosnian"],
  hrv: ["hr", "Croatian"],
  nld: ["nl", "Dutch"],
  srp: ["sr", "Serbian"],
  tha: ["th", "Thai"],
  ckb: ["ku", "Central Kurdish"],
  yor: ["yo", "Yoruba"],
  uzn: ["uz", "Uzbek"],
  zlm: ["ms", "Malay"],
  ces: ["cs", "Czech"],
  ell: ["el", "Greek"],
  hun: ["hu", "Hungarian"],
  swe: ["sv", "Swedish"],
  bul: ["bg", "Bulgarian"],
  dan: ["da", "Danish"],
  fin: ["fi", "Finnish"],
  slk: ["sk", "Slovak"],
  heb: ["he", "Hebrew"],
  nob: ["no", "Norwegian"],
  nno: ["nn", "Norwegian Nynorsk"],
  cat: ["ca", "Catalan"],
  glg: ["gl", "Galician"],
  lit: ["lt", "Lithuanian"],
  lvs: ["lv", "Latvian"],
  ekk: ["et", "Estonian"],
  slv: ["sl", "Slovenian"],
  mkd: ["mk", "Macedonian"],
  als: ["sq", "Albanian"],
  bel: ["be", "Belarusian"],
  kaz: ["kk", "Kazakh"],
  kir: ["ky", "Kyrgyz"],
  tgk: ["tg", "Tajik"],
  tuk: ["tk", "Turkmen"],
  azj: ["az", "Azerbaijani"],
  hat: ["ht", "Haitian Creole"],
  zul: ["zu", "Zulu"],
  xho: ["xh", "Xhosa"],
  sna: ["sn", "Shona"],
  som: ["so", "Somali"],
  afr: ["af", "Afrikaans"],
  ibo: ["ig", "Igbo"],
  lin: [null, "Lingala"],
  lug: [null, "Ganda"],
  kin: ["rw", "Kinyarwanda"],
  epo: ["eo", "Esperanto"],
  tat: ["tt", "Tatar"],
  tgl: ["tl", "Tagalog"],
  ceb: [null, "Cebuano"],
  ilo: [null, "Iloko"],
  war: [null, "Waray"],
  npi: ["ne", "Nepali"],
  sco: [null, "Scots"],
  und: [null, "Undetermined"],
};

/**
 * Detects the dominant language of subtitle dialogue text.
 * @param {string} text Plain dialogue text (timestamps/formatting stripped).
 * @returns {{ iso3: string, code: string, label: string, confidence: number } | null}
 *   `code` is the short filename-friendly tag (2-letter when we have one,
 *   otherwise the 3-letter code); `null` if there wasn't enough text to tell.
 */
export function detectSubtitleLanguage(text) {
  const [iso3, confidence] = francAll(text || "", { minLength: 10 })[0];
  if (!iso3 || iso3 === "und") return null;

  const [short, name] = ISO_639_3[iso3] || [null, null];
  return {
    iso3,
    code: short || iso3,
    label: name || iso3,
    confidence, // already normalized 0–1 by franc
  };
}
