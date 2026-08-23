import { useEffect, useRef, useState } from "react";
import { TOOL_CATEGORIES } from "../lib/toolsRegistry";

export default function AllToolsMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="all-tools" ref={rootRef}>
      <button
        type="button"
        className={`all-tools__trigger ${open ? "all-tools__trigger--open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        All tools
        <span className="all-tools__chevron">▾</span>
      </button>

      {open && (
        <div className="all-tools__panel" role="menu">
          {TOOL_CATEGORIES.map((cat) => (
            <div className="all-tools__col" key={cat.key}>
              <div className="all-tools__colhead">
                <span className="all-tools__icon">{cat.icon}</span>
                {cat.label.toUpperCase()}
              </div>
              <ul className="all-tools__list">
                {cat.tools.map((t) => (
                  <li key={t.id}>
                    <a href={`#/${t.route === "/" ? "" : t.route}`} onClick={() => setOpen(false)}>
                      <span className="all-tools__caret">›</span>
                      {t.label}
                      {t.badge && <span className="all-tools__new">{t.badge}</span>}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
