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

export function stripExt(name) {
  return name.replace(/\.[^./]+$/, "");
}
