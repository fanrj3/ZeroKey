// Render the same official Lucide icons used by the UI into native menu bitmaps.
// Pass an installed sharp module path if sharp is not in the local dev environment.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppWindow,
  Fingerprint,
  Settings2,
  RefreshCw,
  Power,
  Server,
  FolderKey,
  ChartNoAxesCombined,
  Clock3,
} from "lucide-react";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const { default: sharp } = await import(
  process.argv[2] ? pathToFileURL(process.argv[2]).href : "sharp"
);
const directory = fileURLToPath(
  new URL("../src-tauri/icons/menu/", import.meta.url),
);
await mkdir(directory, { recursive: true });
const icons = {
  open: AppWindow,
  review: Fingerprint,
  settings: Settings2,
  refresh: RefreshCw,
  quit: Power,
  gateway: Server,
  projects: FolderKey,
  usage: ChartNoAxesCombined,
  checked: Clock3,
};
for (const [name, icon] of Object.entries(icons)) {
  const svg = renderToStaticMarkup(
    createElement(icon, { size: 16, color: "#737373", strokeWidth: 2 }),
  );
  await writeFile(join(directory, `${name}.svg`), svg + "\n");
  const rgba = await sharp(Buffer.from(svg), { density: 384 })
    .resize(16, 16)
    .ensureAlpha()
    .raw()
    .toBuffer();
  if (rgba.length !== 16 * 16 * 4) throw new Error("Invalid icon dimensions");
  await writeFile(join(directory, `${name}.rgba`), rgba);
}
await copyFile(
  new URL("../node_modules/lucide-react/LICENSE", import.meta.url),
  join(directory, "LICENSE"),
);
console.log(
  `Generated ${Object.keys(icons).length} official Lucide menu icons (16 × 16 RGBA).`,
);
