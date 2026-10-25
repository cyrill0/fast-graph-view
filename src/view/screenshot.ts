/** Save a user-requested PNG without accessing the system clipboard or vault. */
export function downloadScreenshot(doc: Document, dataUrl: string): void {
  if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("Invalid PNG data URL");
  const link = doc.body.createEl("a", {
    href: dataUrl,
    attr: { download: "fast-graph-view.png" },
  });
  try {
    link.click();
  } finally {
    link.remove();
  }
}
