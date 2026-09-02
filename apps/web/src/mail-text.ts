export function plainText(html: string) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

export function escapeHTML(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
