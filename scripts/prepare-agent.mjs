import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const output = resolve("src-tauri/resources");
await mkdir(join(output, "agent"), { recursive: true });
const result = await build({
  entryPoints: ["mcp", "zerokey", "integration", "mcp-config"].map(
    (name) => `scripts/${name}.ts`,
  ),
  outdir: join(output, "agent"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  mainFields: ["module", "main"],
  target: "node22",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  minify: true,
  legalComments: "eof",
  metafile: true,
});
// Ship the licenses of every bundled third-party package, including transitive packages.
const licenses = new Map();
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const production = Object.entries(lock.packages)
  .filter(([path, value]) => path && !value.dev)
  .map(([path]) => `${path}/package.json`);
for (const input of [...Object.keys(result.metafile.inputs), ...production]) {
  if (!input.includes("node_modules/")) continue;
  let folder = dirname(resolve(input));
  while (folder.includes("node_modules")) {
    try {
      const manifest = JSON.parse(
        await readFile(join(folder, "package.json"), "utf8"),
      );
      if (manifest.name && !licenses.has(manifest.name)) {
        let text = "";
        for (const name of [
          "LICENSE",
          "LICENSE.md",
          "LICENSE.txt",
          "License.txt",
          "license",
          "license.md",
          "OFL.txt",
        ]) {
          try {
            text = await readFile(join(folder, name), "utf8");
            break;
          } catch {}
        }
        licenses.set(
          manifest.name,
          `${manifest.name}@${manifest.version} (${manifest.license ?? "see package"})\n${text}`,
        );
      }
      break;
    } catch {
      folder = dirname(folder);
    }
  }
}
await writeFile(
  join(output, "THIRD-PARTY-NOTICES.txt"),
  [...licenses.values()].join("\n\n----\n\n"),
);
await copyFile("LICENSE", join(output, "LICENSE"));
console.log(
  `Bundled 4 Agent entry points and ${licenses.size} dependency notices.`,
);
