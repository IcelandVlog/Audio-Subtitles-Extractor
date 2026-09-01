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
 * franc's trigram model is excellent for telling unrelated languages apart,
 * but a handful of standard-language pairs share almost their entire trigram
 * profile because they're mutually intelligible with mostly the same script
 * and grammar — Croatian/Bosnian/Serbian(-Latin), and Indonesian/Malay.
 * Trigram frequency alone regularly can't separate these, but each pair has
 * real vocabulary that reliably differs between the standards (e.g. Croatian
 * "kruh" vs Bosnian/Serbian "hljeb"/"hleb" for bread, or Serbian's ekavian
 * "vreme" vs Croatian/Bosnian ijekavian "vrijeme" for time). We score each
 * cluster member by how many of its marker words actually appear in the
 * text and let that override franc's raw guess; with no marker words found
 * anywhere, franc's own top pick is left untouched rather than guessing blind.
 */
const CONFUSABLE_CLUSTERS = [
  {
    members: ["hrv", "bos", "srp"],
    groups: [
      // Croatian-only vocabulary — no other standard uses these words.
      {
        weight: { hrv: 2 },
        words: [
          "tisuću", "tisuća", "kruh", "tjedan", "glazba", "općina", "vlak", "tvrtka",
          "vjerojatno", "siječanj", "veljača", "ožujak", "travanj", "lipanj", "srpanj",
          "kolovoz", "rujan", "listopad", "studeni", "prosinac",
        ],
      },
      // Ijekavian forms — used by Croatian AND Bosnian, never by standard Serbian.
      {
        weight: { hrv: 1, bos: 1 },
        words: ["vrijeme", "rijeka", "mlijeko", "lijep", "snijeg", "djevojka", "čovjek", "pjesma"],
      },
      // Ekavian forms — the Serbian standard's signature, never Croatian/Bosnian.
      {
        weight: { srp: 2 },
        words: ["vreme", "reka", "mleko", "lep", "sneg", "devojka", "čovek", "covek", "pesma"],
      },
      // Vocabulary Bosnian and Serbian share but Croatian doesn't use.
      { weight: { bos: 1, srp: 1 }, words: ["opština", "voz", "muzika", "hiljada", "hiljadu"] },
      // "Bread" spelling splits three ways: kruh (hrv) / hljeb (bos) / hleb (srp).
      { weight: { bos: 2 }, words: ["hljeb"] },
      { weight: { srp: 2 }, words: ["hleb"] },
    ],
  },
  {
    members: ["ind", "zlm"],
    groups: [
      {
        weight: { ind: 1 },
        words: ["karena", "nggak", "enggak", "banget", "gimana", "kayak", "udah", "kalo", "dong", "nih", "sih", "kok"],
      },
      {
        weight: { zlm: 1 },
        words: ["kerana", "hendak", "mesti", "awak", "sahaja", "boleh", "nak", "lah", "kot", "punyalah"],
      },
    ],
  },
];

function refineConfusable(iso3, text) {
  const cluster = CONFUSABLE_CLUSTERS.find((c) => c.members.includes(iso3));
  if (!cluster) return iso3;

  const lower = text.toLowerCase();
  const scores = Object.fromEntries(cluster.members.map((m) => [m, 0]));
  for (const group of cluster.groups) {
    for (const word of group.words) {
      const matches = lower.match(new RegExp(`\\b${word}\\b`, "g"));
      if (!matches) continue;
      for (const [member, weight] of Object.entries(group.weight)) {
        scores[member] += matches.length * weight;
      }
    }
  }

  let best = iso3;
  let bestScore = scores[iso3] ?? 0;
  let totalEvidence = 0;
  for (const [member, score] of Object.entries(scores)) {
    totalEvidence += score;
    if (score > bestScore) {
      bestScore = score;
      best = member;
    }
  }
  // No marker words found anywhere in the cluster — no evidence to override
  // franc's own guess with, so leave it as-is rather than flipping blind.
  return totalEvidence > 0 ? best : iso3;
}

/**
 * Detects the dominant language of subtitle dialogue text.
 * @param {string} text Plain dialogue text (timestamps/formatting stripped).
 * @returns {{ iso3: string, code: string, label: string, confidence: number } | null}
 *   `code` is the short filename-friendly tag (2-letter when we have one,
 *   otherwise the 3-letter code); `null` if there wasn't enough text to tell.
 */
export function detectSubtitleLanguage(text) {
  const [iso3Raw, confidence] = francAll(text || "", { minLength: 10 })[0];
  if (!iso3Raw || iso3Raw === "und") return null;

  const iso3 = refineConfusable(iso3Raw, text || "");
  const [short, name] = ISO_639_3[iso3] || [null, null];
  return {
    iso3,
    code: short || iso3,
    label: name || iso3,
    confidence, // already normalized 0–1 by franc
  };
}
