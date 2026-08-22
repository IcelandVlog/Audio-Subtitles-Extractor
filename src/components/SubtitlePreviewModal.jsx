export default function SubtitlePreviewModal({ text, onClose }) {
  return (
    <div className="subtitle-modal-overlay" onClick={onClose}>
      <div
        className="subtitle-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Subtitle content"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="subtitle-modal__head">
          <h3>Subtitle content</h3>
          <button className="subtitle-modal__close" onClick={onClose} aria-label="Close preview">
            ✕
          </button>
        </div>
        <pre className="subtitle-modal__body">{text}</pre>
      </div>
    </div>
  );
}
