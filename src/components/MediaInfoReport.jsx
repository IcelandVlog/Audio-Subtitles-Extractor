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

// Shows, per file: length, size, container, and for each video stream its
// resolution, frame rate, bitrate and a quality rating; plus audio tracks.
export default function MediaInfoReport({ reports }) {
  return (
    <div className="mediainfo">
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

          {r.audio.length > 0 && (
            <div className="mediainfo__block">
              <h4 className="mediainfo__subtitle">Audio tracks ({r.audio.length})</h4>
              <ul className="mediainfo__list">
                {r.audio.map((a, j) => (
                  <li key={`a-${j}`}>
                    {j + 1}. {a.codec}
                    {a.language ? ` [${a.language}]` : ""}
                    {a.channels ? `, ${a.channels}` : ""}
                    {a.sampleRate ? `, ${a.sampleRate} Hz` : ""}
                    {a.bitrateKbps ? `, ${a.bitrateKbps} kb/s` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mediainfo__muted">Subtitle tracks: {r.subtitles}</p>
        </section>
      ))}
    </div>
  );
}
