import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { basename } from "node:path";

await mkdir("public/assets", { recursive: true });
const css = await readFile("reference/source.css", "utf8");
const fonts = [...css.matchAll(/@font-face\s*\{[^}]+\}/g)].map((m) => m[0]);
const urls = [
  ...new Set(
    fonts.flatMap((rule) =>
      [...rule.matchAll(/url\("(https:[^"]+)"\)/g)].map((m) => m[1]),
    ),
  ),
];
await Promise.all(
  urls.map(async (url) => {
    const destination = `public/assets/${basename(url)}`;
    try {
      await access(destination);
      return;
    } catch {}
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Asset ${basename(url)}: ${response.status}`);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  }),
);
await writeFile(
  "public/assets/fonts.css",
  fonts
    .join("\n")
    .replaceAll(
      /https:\/\/mail\.superhuman\.com\/~backend\/build\//g,
      "/assets/",
    )
    .replaceAll("font-display: block", "font-display: swap")
    .replaceAll('format("truetype")', ""),
);
const icons = {};
for (const file of [
  "reference/icons.json",
  "reference/more-icons.json",
  "reference/reader-icons.json",
]) {
  let entries;
  try {
    entries = JSON.parse(await readFile(file, "utf8"));
  } catch {
    continue;
  }
  for (const entry of Array.isArray(entries)
    ? entries
    : Object.values(entries)) {
    const html = entry.html || entry.svg;
    const name = entry.name || entry.label;
    if (!name || !html) continue;
    icons[name] = html
      .replaceAll(
        /\s(?:aria-label|aria-hidden|role|class|style|focusable)="[^"]*"/g,
        "",
      )
      .replaceAll(
        /(?:fill|stroke)="(?:#141413|red|var\(--origin-color-icon-base-default\))"/g,
        (match) =>
          `${match.startsWith("fill") ? "fill" : "stroke"}="currentColor"`,
      )
      .replaceAll(/fill="url\(#[^)]+\)"/g, 'fill="currentColor"');
  }
}
const commandIcon = css.match(
  /\.Command-header-icon \{ background-image: url\("data:image\/svg\+xml;base64,([^"]+)"/,
);
if (commandIcon)
  icons.Command = Buffer.from(commandIcon[1], "base64")
    .toString("utf8")
    .replaceAll(/fill="#FFF"/g, 'fill="currentColor"');
await writeFile("src/icons.json", JSON.stringify(icons));
console.log(
  `Saved ${urls.length} font files and ${Object.keys(icons).length} icons`,
);
