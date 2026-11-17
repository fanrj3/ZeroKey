Native menu icons are rendered from the installed official `lucide-react` package by
`scripts/generate-tray-icons.mjs`. The SVG sources and Lucide license are included.

Each `.rgba` is 16 × 16 pixels, four bytes per pixel (RGBA), transparent background,
neutral `#737373` stroke. Tauri embeds these 1 KiB bitmaps directly, so the application
does not need an SVG renderer, image decoder, or an additional runtime dependency.

Regenerate with `node scripts/generate-tray-icons.mjs [path-to-installed-sharp-module]`.
