import { resolutionClass } from "../lib/mediaInfo";

const QUALITY_COLORS = {
  Excellent: "#3fb950",
  Good: "#58a6ff",
  Fair: "#d29922",
  Poor: "#f85149",
};

function Row({ label, value }) {
  return (
    <div className="mediainfo__row">
      <span className="mediainfo__label">{label}</span>
      <span className="mediainfo__value">{value}</span>
    </div>
  );
}

// Index of the best entry for a metric (null when no file has a value).
// `better` is "max" or "min". Ties keep the first file.
function bestIndex(reports, pick, better) {
  let best = null;
  reports.forEach((r, i) => {
    const val = pick(r);
    if (val == null || !Number.isFinite(val)) return;
    if (best === null || (better === "max" ? val > best.val : val < best.val)) {
      best = { i, val };
    }
  });
  return best && reports.length > 1 ? best.i : null;
}

// Compare several files: one row each, the best value per column highlighted,
// and a short verdict on which file wins each measure.
function ComparisonCard({ reports }) {
  const v0 = (r) => r.video[0];
  const metrics = {
    resolution: { pick: (r) => (v0(r)?.width && v0(r)?.height ? v0(r).width * v0(r).height : null), better: "max", label: "Highest resolution" },
    fps: { pick: (r) => v0(r)?.fps ?? null, better: "max", label: "Highest frame rate" },
    bitrate: { pick: (r) => v0(r)?.bitrateKbps ?? null, better: "max", label: "Highest video bitrate" },
    size: { pick: (r) => r.size ?? null, better: "min", label: "Smallest file" },
    length: { pick: (r) => r.durationSeconds ?? null, better: "max", label: "Longest" },
  };
  const best = Object.fromEntries(
    Object.entries(metrics).map(([k, m]) => [k, bestIndex(reports, m.pick, m.better)])
  );
  const hl = (idx, key) => (best[key] === idx ? "mediainfo__best" : undefined);

  const verdicts = Object.entries(metrics)
    .filter(([k]) => best[k] !== null)
    .map(([k, m]) => ({ label: m.label, file: reports[best[k]].fileName }));

  return (
    <div className="mediainfo__card mediainfo__summary">
      <h3 className="mediainfo__title">Comparison ({reports.length} files)</h3>
      <div className="mediainfo__tablewrap">
        <table className="mediainfo__table">
          <thead>
            <tr>
              <th>File</th>
              <th>Length</th>
              <th>Size</th>
              <th>Resolution</th>
              <th>FPS</th>
              <th>Video bitrate</th>
              <th>Quality</th>
              <th>Audio</th>
              <th>Subs</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r, i) => {
              const v = v0(r);
              return (
                <tr key={`s-${r.fileName}-${i}`}>
                  <td className="mediainfo__name" title={r.fileName}>{r.fileName}</td>
                  <td className={hl(i, "length")}>{r.durationText}</td>
                  <td className={hl(i, "size")}>{r.sizeText}</td>
                  <td className={hl(i, "resolution")}>
                    {v && v.width && v.height ? `${v.width}x${v.height} (${resolutionClass(v.width, v.height)})` : "—"}
                  </td>
                  <td className={hl(i, "fps")}>{v && v.fps ? v.fps : "—"}</td>
                  <td className={hl(i, "bitrate")}>{v && v.bitrateKbps ? `${v.bitrateKbps} kb/s` : "—"}</td>
                  <td style={{ color: v?.quality ? QUALITY_COLORS[v.quality.label] : undefined }}>
                    {v?.quality ? v.quality.label : "—"}
                  </td>
                  <td>{r.audio.length}</td>
                  <td>{r.subtitles}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {verdicts.length > 0 && (
        <ul className="mediainfo__list mediainfo__verdicts">
          {verdicts.map((x) => (
            <li key={x.label}>
              <span className="mediainfo__muted">{x.label}:</span> <strong>{x.file}</strong>
            </li>
          ))}
        </ul>
      )}
      <p className="mediainfo__muted">Highlighted cells show the best value in each column.</p>
    </div>
  );
}

// Shows, per file: length, size, container, and for each video stream its
// resolution, frame rate, bitrate and a quality rating; plus audio and subtitle tracks.
export default function MediaInfoReport({ reports }) {
  return (
    <div className="mediainfo">
      {reports.length > 1 && <ComparisonCard reports={reports} />}

      {reports.map((r, i) => (
        <section className="mediainfo__card" key={`${r.fileName}-${i}`}>
          <h3 className="mediainfo__title" title={r.fileName}>
            {r.fileName}
          </h3>
          <div className="mediainfo__grid">
            <Row label="Length" value={r.durationText} />
            <Row label="File size" value={r.sizeText} />
            <Row label="Container" value={r.container} />
            {r.overallBitrateKbps ? <Row label="Overall bitrate" value={`${r.overallBitrateKbps} kb/s`} /> : null}
          </div>

          {r.video.length === 0 && <p className="mediainfo__muted">No video stream (audio only).</p>}

          {r.video.map((v, j) => (
            <div className="mediainfo__block" key={`v-${j}`}>
              <h4 className="mediainfo__subtitle">
                Video{r.video.length > 1 ? ` ${j + 1}` : ""}: {v.codec}
                {v.profile ? ` (${v.profile})` : ""}
              </h4>
              <div className="mediainfo__grid">
                <Row
                  label="Resolution"
                  value={
                    v.width && v.height
                      ? `${v.width}x${v.height} · ${resolutionClass(v.width, v.height)}`
                      : "unknown"
                  }
                />
                <Row label="Frame rate" value={v.fps ? `${v.fps} fps` : "unknown"} />
                <Row
                  label="Bitrate"
                  value={
                    v.bitrateKbps
                      ? `${v.bitrateKbps} kb/s${v.bitrateEstimated ? " (estimated)" : ""}`
                      : "unknown"
                  }
                />
                {v.pixelFormat ? <Row label="Pixel format" value={v.pixelFormat} /> : null}
                {v.hdr ? <Row label="HDR" value="Yes" /> : null}
              </div>
              {v.quality ? (
                <p className="mediainfo__quality" style={{ color: QUALITY_COLORS[v.quality.label] }}>
                  Quality: {v.quality.label}{" "}
                  <span className="mediainfo__muted">— {v.quality.note}</span>
                </p>
              ) : (
                <p className="mediainfo__muted">Quality rating needs resolution, frame rate and bitrate.</p>
              )}
            </div>
          ))}

          <div className="mediainfo__tracks">
          {r.audio.length > 0 && (
            <div className="mediainfo__block">
              <h4 className="mediainfo__subtitle">Audio tracks ({r.audio.length})</h4>
              <ul className="mediainfo__list">
                {r.audio.map((a, j) => (
                  <li key={`a-${j}`}>
                    {j + 1}. {a.codec}
                    {` - ${a.languageText}${a.title ? ` - ${a.title}` : ""}`}
                    {a.channels ? `, ${a.channels}` : ""}
                    {a.sampleRate ? `, ${a.sampleRate} Hz` : ""}
                    {a.bitrateKbps ? `, ${a.bitrateKbps} kb/s` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {r.subtitleTracks.length > 0 && (
            <div className="mediainfo__block">
              <h4 className="mediainfo__subtitle">Subtitle tracks ({r.subtitleTracks.length})</h4>
              <ul className="mediainfo__list">
                {r.subtitleTracks.map((s, j) => (
                  <li key={`s-${j}`}>
                    {j + 1}. {s.codec}
                    {` - ${s.languageText}${s.title ? ` - ${s.title}` : ""}`}
                    {s.flags.length ? ` (${s.flags.join(", ")})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          </div>
        </section>
      ))}
    </div>
  );
}
