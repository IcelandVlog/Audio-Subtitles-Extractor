import { useEffect, useRef, useState } from "react";

const CATEGORIES = [
  {
    id: "converters",
    label: "CONVERTERS",
    icon: "⇄",
    items: [
      { id: "convert-to-srt", label: "Convert to Srt" },
      { id: "convert-to-webvtt", label: "Convert to WebVtt" },
      { id: "sup-to-srt", label: "Sup to Srt Converter" },
      { id: "subidx-to-srt", label: "Sub/Idx to Srt Converter" },
      { id: "convert-to-plaintext", label: "Convert to Plain Text" },
      { id: "convert-to-pdf", label: "Convert to PDF" },
    ],
  },
  {
    id: "syncing",
    label: "SYNCING",
    icon: "↻",
    items: [
      { id: "subtitle-shifter", label: "Subtitle Shifter" },
      { id: "partial-subtitle-shifter", label: "Partial Subtitle Shifter" },
    ],
  },
  {
    id: "fixing",
    label: "FIXING",
    icon: "⧉",
    items: [
      { id: "srt-cleaner", label: "Srt Cleaner" },
      { id: "convert-to-utf8", label: "Convert to UTF-8" },
    ],
  },
  {
    id: "other",
    label: "OTHER",
    icon: "✦",
    items: [
      { id: "subtitle-merger", label: "Subtitle Merger" },
      { id: "archive-extractor", label: "Zip/Rar Extractor", badge: "New!" },
      { id: "video-to-subtitles", label: "Video to Subtitle Converter", badge: "New!" },
      { id: "detect-language", label: "Subtitle Language Detector", badge: "New!" },
      { id: "timed-lyrics-editor", label: "Timed Lyrics Editor", badge: "New!" },
      { id: "color-changer", label: "Color changer" },
      { id: "position-changer", label: "Position changer" },
      { id: "make-pinyin-subtitles", label: "Make Pinyin Subtitles" },
      { id: "compress-audio", label: "Audio Compressor", badge: "New!" },
    ],
  },
];

export default function AllToolsMenu({ onSelectTool }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // every category starts open, matching the screenshot
  const [openCats, setOpenCats] = useState(() =>
    Object.fromEntries(CATEGORIES.map((c) => [c.id, true]))
  );
  const menuRef = useRef(null);
  const btnRef = useRef(null);

  const toggleCategory = (id) => {
    setOpenCats((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // close on outside click / tap and on Escape
  useEffect(() => {
    if (!menuOpen) return;

    const handlePointer = (e) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target) &&
        btnRef.current &&
        !btnRef.current.contains(e.target)
      ) {
        setMenuOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === "Escape") setMenuOpen(false);
    };

    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  const handleItemClick = (id) => {
    setMenuOpen(false);
    onSelectTool?.(id);
  };

  return (
    <div className="all-tools">
      <button
        ref={btnRef}
        type="button"
        className={`all-tools__btn ${menuOpen ? "all-tools__btn--open" : ""}`}
        aria-expanded={menuOpen}
        aria-haspopup="true"
        onClick={() => setMenuOpen((v) => !v)}
      >
        All tools <span className="all-tools__caret">{menuOpen ? "⌃" : "⌄"}</span>
      </button>

      {menuOpen && (
        <div className="all-tools__panel" ref={menuRef} role="menu">
          {CATEGORIES.map((cat) => {
            const isOpen = !!openCats[cat.id];
            return (
              <div className="cat-group" key={cat.id}>
                <button
                  type="button"
                  className={`cat-header ${isOpen ? "cat-header--open" : ""}`}
                  aria-expanded={isOpen}
                  onClick={() => toggleCategory(cat.id)}
                >
                  <span className="cat-header__label">
                    <span className="cat-header__icon" aria-hidden="true">
                      {cat.icon}
                    </span>
                    {cat.label}
                  </span>
                  <span className="cat-header__chev" aria-hidden="true">
                    ⌄
                  </span>
                </button>

                <CategoryItems open={isOpen} items={cat.items} onSelect={handleItemClick} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CategoryItems({ open, items, onSelect }) {
  const innerRef = useRef(null);
  const [maxHeight, setMaxHeight] = useState(open ? "none" : "0px");

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;

    if (open) {
      // measure real content height so the animation is exact, no clipped/extra space
      const h = el.scrollHeight;
      setMaxHeight(h + "px");
      const t = setTimeout(() => setMaxHeight("none"), 220);
      return () => clearTimeout(t);
    } else {
      // if it was "none", first snap to the current pixel height, then collapse
      const h = el.scrollHeight;
      setMaxHeight(h + "px");
      requestAnimationFrame(() => setMaxHeight("0px"));
    }
  }, [open]);

  return (
    <div
      className={`cat-items ${open ? "cat-items--open" : ""}`}
      style={{ maxHeight }}
    >
      <div ref={innerRef}>
        {items.map((item) => (
          <div
            className="cat-items__item"
            key={item.id}
            role="menuitem"
            tabIndex={0}
            onClick={() => onSelect(item.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelect(item.id);
            }}
          >
            <span aria-hidden="true">›</span> {item.label}
            {item.badge && <span className="cat-items__badge">{item.badge}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
