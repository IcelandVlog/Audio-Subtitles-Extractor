/** Trigger a browser download for a Blob without any extra click from the user. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // give the browser a tick to pick up the click before we revoke it
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Download an extraction result, including any companion files. A DVD/VobSub
 * track is a .sub + .idx pair, so this saves both under the same base name
 * (players/converters match the two by name). Browsers ask once to allow
 * "multiple downloads", hence the small stagger between files.
 */
export function downloadResultFiles(result, baseName) {
  downloadBlob(result.blob, `${baseName}.${result.extension}`);
  (result.companions || []).forEach((c, i) => {
    setTimeout(() => downloadBlob(c.blob, `${baseName}.${c.extension}`), 350 * (i + 1));
  });
}

/** Add a result (plus companions) to a zip, keeping companions' names in step with the main file's. */
export function addResultToZip(zip, fullName, result) {
  zip.file(fullName, result.blob);
  const stem = fullName.replace(/\.[^./]+$/, "");
  for (const c of result.companions || []) zip.file(`${stem}.${c.extension}`, c.blob);
}

export function stripExt(name) {
  return name.replace(/\.[^./]+$/, "");
}
