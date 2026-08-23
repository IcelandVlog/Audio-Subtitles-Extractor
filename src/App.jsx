import { useEffect, useState } from "react";
import AllToolsMenu from "./components/AllToolsMenu";
import { useHashRoute } from "./lib/useHashRoute";
import { ALL_TOOLS } from "./lib/toolsRegistry";
import Home from "./pages/Home";
import ConvertToSrt from "./pages/ConvertToSrt";
import ConvertToVtt from "./pages/ConvertToVtt";
import SupToSrt from "./pages/SupToSrt";
import SubIdxToSrt from "./pages/SubIdxToSrt";
import ConvertToText from "./pages/ConvertToText";
import ConvertToPdf from "./pages/ConvertToPdf";
import SubtitleShifter from "./pages/SubtitleShifter";
import PartialSubtitleShifter from "./pages/PartialSubtitleShifter";
import SrtCleaner from "./pages/SrtCleaner";
import ConvertToUtf8 from "./pages/ConvertToUtf8";
import SubtitleMerger from "./pages/SubtitleMerger";
import TimedLyricsEditor from "./pages/TimedLyricsEditor";
import ColorChanger from "./pages/ColorChanger";
import PositionChanger from "./pages/PositionChanger";
import PinyinSubtitles from "./pages/PinyinSubtitles";
import "./App.css";

const THEME_KEY = "strip-theme";

const ROUTES = {
  "to-srt": ConvertToSrt,
  "to-vtt": ConvertToVtt,
  "sup-to-srt": SupToSrt,
  "subidx-to-srt": SubIdxToSrt,
  "to-text": ConvertToText,
  "to-pdf": ConvertToPdf,
  shifter: SubtitleShifter,
  "partial-shifter": PartialSubtitleShifter,
  cleaner: SrtCleaner,
  "to-utf8": ConvertToUtf8,
  merger: SubtitleMerger,
  "lyrics-editor": TimedLyricsEditor,
  "color-changer": ColorChanger,
  "position-changer": PositionChanger,
  pinyin: PinyinSubtitles,
};

export default function App() {
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "dark";
    return localStorage.getItem(THEME_KEY) || "dark";
  });
  const route = useHashRoute();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  const ToolPage = ROUTES[route];
  const activeTool = ALL_TOOLS.find((t) => t.route === route);

  return (
    <>
      <div className="grain" />
      <header className="nav">
        <a className="nav__mark" href="#/">
          <span className="nav__dot" />
          STRIP
        </a>
        <AllToolsMenu />
        <div className="nav__right">
          <a
            className="nav__link"
            href="https://github.com/Bisalkumar/Audio-Extractor"
            target="_blank"
            rel="noreferrer"
          >
            source ↗
          </a>
          <button
            type="button"
            className="nav__theme"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      <main className="shell">
        {ToolPage ? <ToolPage key={activeTool?.id || route} /> : <Home />}
      </main>

      <footer className="footer">
        <p>
          Built on <span className="mono">ffmpeg.wasm</span> — decoding happens on your CPU, in your
          tab. Large files may take a while and use real memory.
        </p>
      </footer>
    </>
  );
}
