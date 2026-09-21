const BAR_COUNT = 28;

// Deterministic pseudo-random per-bar timing so the meter feels alive but never chaotic.
const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
  const seed = Math.sin(i * 12.9898) * 43758.5453;
  const frac = seed - Math.floor(seed);
  return {
    delay: (frac * 1.8).toFixed(2),
    duration: (1.1 + frac * 1.3).toFixed(2),
    peak: Math.round(28 + frac * 62),
  };
});

export default function Meter({ active = false }) {
  return (
    <div className={`meter ${active ? "meter--active" : ""}`} aria-hidden="true">
      {bars.map((b, i) => (
        <span
          key={i}
          className="meter__bar"
          style={{
            animationDelay: `${b.delay}s`,
            animationDuration: `${b.duration}s`,
            "--peak": `${b.peak}%`,
          }}
        />
      ))}
    </div>
  );
}
