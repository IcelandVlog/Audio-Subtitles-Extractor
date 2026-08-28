import { useRef, useState } from "react";
import { openArchive, SUPPORTS_FOLDER_SAVE } from "../lib/archive";
import { downloadBlob, stripExt } from "../lib/download";
import { formatSize } from "../lib/format";
import JSZip from "jszip";

export default function ArchiveExtractor({ onHome }) {
  const [file, setFile] = useState(null);
  const [archive, setArchive] = useState(null); // { kind, sizeLimited } from openArchive
  const [rows, setRows] = useState([]); // per-entry UI state: { name, size, status, error }
  const [listStatus, setListStatus] = useState("idle"); // idle | listing | listed | error
  const [listError, setListError] = useState("");
  const [bulkStatus, setBulkStatus] = useState("idle"); // idle | extracting | done | error
  const [bulkProgress, setBulkProgress] = useState(0);
  const [bulkBlob, setBulkBlob] = useState(null);
  const [bulkError, setBulkError] = useState("");
  const [bulkSavedToFolder, setBulkSavedToFolder] = useState(false);
  const [bulkFailedCount, setBulkFailedCount] = useState(0);
  const inputRef = useRef(null);
  const archiveRef = useRef(null); // holds the live extractOne/extractAll handle (not state — no need to re-render on this)

  const busy = listStatus === "listing" || bulkStatus === "extracting" || rows.some((r) => r.status === "extracting");

  const reset = () => {
    setFile(null);
    setArchive(null);
    setRows([]);
    setListStatus("idle");
    setListError("");
    setBulkStatus("idle");
    setBulkProgress(0);
    setBulkBlob(null);
    setBulkError("");
    setBulkSavedToFolder(false);
    setBulkFailedCount(0);
    archiveRef.current = null;
  };

  const handlePick = async (f) => {
    if (!f || busy) return;
    reset();
    setFile(f);
    setListStatus("listing");
    try {
      const opened = await openArchive(f);
      archiveRef.current = opened;
      setArchive({ kind: opened.kind, sizeLimited: opened.sizeLimited });
      setRows(opened.entries.map((e) => ({ name: e.name, size: e.size, status: "idle", error: null })));
      setListStatus("listed");
    } catch (err) {
      setListError(err?.message || "Couldn't read that archive.");
      setListStatus("error");
    }
  };

  const patchRow = (name, patch) => {
    setRows((prev) => prev.map((r) => (r.name === name ? { ...r, ...patch } : r)));
  };

  const handleExtractOne = async (name) => {
    patchRow(name, { status: "extracting", error: null });
    try {
      const blob = await archiveRef.current.extractOne(name);
      patchRow(name, { status: "done", blob });
    } catch (err) {
      patchRow(name, { status: "error", error: err?.message || "Extraction failed." });
    }
  };

  const handleDownloadOne = (name) => {
    const row = rows.find((r) => r.name === name);
    if (!row?.blob) return;
    const flat = name.split("/").pop() || name;
    downloadBlob(row.blob, flat);
  };

  const markResults = (failed) => {
    const failedNames = new Set(failed.map((f) => f.name));
    const failedByName = new Map(failed.map((f) => [f.name, f.error]));
    setRows((prev) =>
      prev.map((r) =>
        failedNames.has(r.name)
          ? { ...r, status: "error", error: failedByName.get(r.name) }
          : { ...r, status: "done" }
      )
    );
    setBulkFailedCount(failed.length);
  };

  // Preferred path on supported browsers (desktop Chrome/Edge): writes every
  // file straight to a folder you pick, one at a time — no size ceiling,
  // since nothing builds up in memory.
  const handleExtractAllToFolder = async () => {
    if (!archiveRef.current) return;
    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch {
      return; // user cancelled the picker
    }
    setBulkStatus("extracting");
    setBulkProgress(0);
    setBulkError("");
    setBulkSavedToFolder(false);
    setRows((prev) => prev.map((r) => ({ ...r, status: "extracting", error: null })));
    try {
      const { failed } = await archiveRef.current.extractAllToDirectory(dirHandle, setBulkProgress);
      markResults(failed);
      setBulkSavedToFolder(true);
      setBulkStatus("done");
    } catch (err) {
      setBulkStatus("error");
      setBulkError(err?.message || "Couldn't extract all files.");
      setRows((prev) => prev.map((r) => (r.status === "extracting" ? { ...r, status: "idle" } : r)));
    }
  };

  // Fallback path (Safari, mobile, or any browser without folder-write
  // access): extract everything, bundle into one zip, offer it as a normal
  // download. Bounded by available memory since the zip is built in-page.
  const handleExtractAllToZip = async () => {
    if (!archiveRef.current) return;
    setBulkStatus("extracting");
    setBulkProgress(0);
    setBulkBlob(null);
    setBulkError("");
    setBulkSavedToFolder(false);
    setRows((prev) => prev.map((r) => ({ ...r, status: "extracting", error: null })));
    try {
      const { files, failed } = await archiveRef.current.extractAll(setBulkProgress);
      markResults(failed);
      const zip = new JSZip();
      for (const f of files) zip.file(f.name, f.blob);
      // STORE, not DEFLATE: everything coming out of an archive is already
      // compressed or incompressible, so re-deflating it would just burn
      // CPU for no size benefit. STORE is a straight, fast copy.
      const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      setBulkBlob(zipBlob);
      setBulkStatus("done");
    } catch (err) {
      setBulkStatus("error");
      setBulkError(err?.message || "Couldn't extract all files.");
      setRows((prev) => prev.map((r) => (r.status === "extracting" ? { ...r, status: "idle" } : r)));
    }
  };

  const handleExtractAll = SUPPORTS_FOLDER_SAVE ? handleExtractAllToFolder : handleExtractAllToZip;

  const handleDownloadAll = () => {
    if (!bulkBlob || !file) return;
    downloadBlob(bulkBlob, `${stripExt(file.name)}-extracted.zip`);
  };

  const kindLabel = archive?.kind === "rar" ? "RAR" : archive?.kind === "zip" ? "ZIP" : "";

  return (
    <main className="shell">
      <section className="tool-page">
        <button type="button" className="tool-page__back" onClick={onHome}>
          ← back to extractor
        </button>

        <p className="eyebrow">OTHER</p>
        <h1 className="tool-page__title">
          Archive Extractor
          <span className="cat-items__badge" style={{ position: "static", marginLeft: 10 }}>
            New!
          </span>
        </h1>
        <p className="tool-page__hint">
          Drop in a .zip or .rar file. Strip reads just the file list first — instantly, even on huge
          archives — then only pulls the bytes of whichever files you actually extract, streamed
          straight off disk. No size limit for .zip on this browser.
          {archive?.kind === "rar" &&
            " .rar files need to be loaded into memory once to open (a limitation of the RAR format itself), so very large .rar archives are bound by your device's available memory."}
          {" "}Everything happens on your device; nothing is uploaded anywhere.
        </p>

        <div
          className="tool-modal__drop tool-page__drop"
          onClick={() => !busy && inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!busy && e.dataTransfer.files?.[0]) handlePick(e.dataTransfer.files[0]);
          }}
          role="button"
          tabIndex={0}
        >
          <input
            ref={inputRef}
            type="file"
            hidden
            accept=".zip,.rar,application/zip,application/x-rar-compressed,application/vnd.rar"
            onChange={(e) => e.target.files?.[0] && handlePick(e.target.files[0])}
          />
          {file ? <p>{file.name}</p> : <p>Drop a .zip or .rar file here or click to browse</p>}
        </div>

        {listStatus === "listing" && <p className="tool-page__hint">Reading the file list…</p>}
        {listStatus === "error" && (
          <>
            <p className="tool-modal__error">{listError}</p>
            <div className="tool-modal__actions">
              <button type="button" className="tool-modal__cancel" onClick={reset}>
                Choose a different file
              </button>
              {file && (
                <button type="button" className="tool-modal__run" onClick={() => handlePick(file)}>
                  Try again
                </button>
              )}
            </div>
          </>
        )}

        {listStatus === "listed" && (
          <>
            <div className="stream-table" style={{ marginTop: 8 }}>
              <div className="stream-table__head">
                <span>
                  {kindLabel} contents
                  <span className="stream-table__count">{rows.length}</span>
                </span>
                <span className="stream-table__head-right">
                  {bulkStatus === "extracting" ? (
                    <span className="stream-table__all-progress">{Math.round(bulkProgress * 100)}%</span>
                  ) : bulkStatus === "done" ? (
                    bulkSavedToFolder ? (
                      <span className="stream-table__all-progress">Saved to folder ✓</span>
                    ) : (
                      <button className="stream-table__all-btn" onClick={handleDownloadAll}>
                        Download all (zip)
                      </button>
                    )
                  ) : (
                    <button
                      className="stream-table__all-btn"
                      disabled={busy || rows.length === 0}
                      onClick={handleExtractAll}
                      title={
                        SUPPORTS_FOLDER_SAVE
                          ? "Extract every file straight to a folder you choose — no size limit"
                          : "Extract every file in one fast pass and download as a zip"
                      }
                    >
                      {SUPPORTS_FOLDER_SAVE ? "Extract all to folder" : "Extract all"}
                    </button>
                  )}
                </span>
              </div>

              {bulkStatus === "error" && <p className="stream-row__error" style={{ padding: "6px 14px 0" }}>{bulkError}</p>}
              {bulkStatus === "done" && bulkFailedCount > 0 && (
                <p className="stream-row__error" style={{ padding: "6px 14px 0" }}>
                  {bulkFailedCount} file{bulkFailedCount > 1 ? "s" : ""} couldn't be extracted — see the rows
                  marked below.
                </p>
              )}

              <div className="stream-table__body">
                {rows.length === 0 ? (
                  <p className="stream-table__empty">This archive is empty.</p>
                ) : (
                  <ul className="stream-table__rows">
                    {rows.map((r) => (
                      <li key={r.name} className="stream-row">
                        <div className="stream-row__label">
                          <span className="stream-row__name" title={r.name}>
                            {r.name}
                          </span>
                          <span className="stream-row__ext">{formatSize(r.size)}</span>
                        </div>
                        <div className="stream-row__action">
                          {r.status === "extracting" ? (
                            <span className="stream-row__pct">…</span>
                          ) : r.status === "done" ? (
                            bulkSavedToFolder ? (
                              <span className="stream-row__pct">saved ✓</span>
                            ) : (
                              <button className="stream-row__link" onClick={() => handleDownloadOne(r.name)}>
                                Download
                              </button>
                            )
                          ) : (
                            <button
                              className="stream-row__link"
                              disabled={busy}
                              onClick={() => handleExtractOne(r.name)}
                            >
                              Extract
                            </button>
                          )}
                        </div>
                        {r.status === "error" && <p className="stream-row__error">{r.error}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="tool-modal__actions">
              <button type="button" className="tool-modal__cancel" onClick={reset} disabled={busy}>
                Reset
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
