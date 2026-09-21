export default function ToolShell({ title, description, children, badge }) {
  return (
    <section className="tool">
      <a className="tool__back" href="#/">
        ← back to extractor
      </a>
      <div className="tool__head">
        <h1 className="tool__title">
          {title}
          {badge && <span className="tool__badge">{badge}</span>}
        </h1>
        {description && <p className="tool__desc">{description}</p>}
      </div>
      <div className="tool__body">{children}</div>
    </section>
  );
}
