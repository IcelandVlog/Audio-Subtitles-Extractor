import { useCallback, useEffect, useState } from "react";

export function usePath() {
  const [path, setPath] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname
  );

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to) => {
    if (to === window.location.pathname) return;
    window.history.pushState({}, "", to);
    setPath(to);
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }, []);

  return [path, navigate];
}

export function toolPathFor(toolId) {
  return `/tools/${toolId}`;
}

export function toolIdFromPath(path) {
  const m = path.match(/^\/tools\/([a-z0-9-]+)\/?$/i);
  return m ? m[1] : null;
}
