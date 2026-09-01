// Single source of truth for every tool: used by the "All tools" nav menu and the router.
export const TOOL_CATEGORIES = [
  {
    key: "converters",
    label: "Converters",
    icon: "⇄",
    tools: [
      { id: "to-srt", label: "Convert to Srt", route: "to-srt" },
      { id: "to-vtt", label: "Convert to WebVtt", route: "to-vtt" },
      { id: "sup-to-srt", label: "Sup to Srt Converter", route: "sup-to-srt" },
      { id: "subidx-to-srt", label: "Sub/Idx to Srt Converter", route: "subidx-to-srt" },
      { id: "to-text", label: "Convert to Plain Text", route: "to-text" },
      { id: "to-pdf", label: "Convert to PDF", route: "to-pdf" },
    ],
  },
  {
    key: "syncing",
    label: "Syncing",
    icon: "⏱",
    tools: [
      { id: "shifter", label: "Subtitle Shifter", route: "shifter" },
      { id: "partial-shifter", label: "Partial Subtitle Shifter", route: "partial-shifter" },
    ],
  },
  {
    key: "fixing",
    label: "Fixing",
    icon: "⧉",
    tools: [
      { id: "cleaner", label: "Srt Cleaner", route: "cleaner" },
      { id: "to-utf8", label: "Convert to UTF-8", route: "to-utf8" },
    ],
  },
  {
    key: "other",
    label: "Other",
    icon: "✦",
    tools: [
      { id: "merger", label: "Subtitle Merger", route: "merger" },
      { id: "extract", label: "Extract Subtitles from Video", route: "/", badge: "New!" },
      { id: "video-to-subtitles", label: "Video to Subtitle Converter", route: "video-to-subtitles", badge: "New!" },
      { id: "detect-language", label: "Subtitle Language Detector", route: "detect-language", badge: "New!" },
      { id: "lyrics-editor", label: "Timed Lyrics Editor", route: "lyrics-editor", badge: "New!" },
      { id: "color-changer", label: "Color changer", route: "color-changer" },
      { id: "position-changer", label: "Position changer", route: "position-changer" },
      { id: "pinyin", label: "Make Pinyin Subtitles", route: "pinyin" },
      { id: "compress-audio", label: "Audio Compressor", route: "compress-audio", badge: "New!" },
    ],
  },
];

export const ALL_TOOLS = TOOL_CATEGORIES.flatMap((c) => c.tools);
