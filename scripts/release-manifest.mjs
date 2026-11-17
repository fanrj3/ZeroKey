import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  copyFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
const cargo = await readFile("src-tauri/Cargo.toml", "utf8");
const version = pkg.version;
if (config.version !== version || !cargo.includes(`version = "${version}"`))
  throw new Error("Version mismatch");
if (
  process.env.GITHUB_REF_NAME &&
  process.env.GITHUB_REF_NAME !== `v${version}`
)
  throw new Error("Tag does not match version");
const folder = "src-tauri/target/release/bundle/nsis";
const asset = `ZeroKey_${version}_x64-setup.exe`;
if (!(await readdir(folder)).includes(asset))
  throw new Error("Windows x64 installer not found");
const signature = (await readFile(join(folder, asset + ".sig"), "utf8")).trim();
if (!signature) throw new Error("Installer signature missing");
const changelog = (await readFile("CHANGELOG.md", "utf8")).replace(/\r\n/g, "\n");
const notes = changelog.split(`## ${version}\n`)[1]?.split(/\n## /)[0]?.trim();
if (!notes) throw new Error("Release notes missing from CHANGELOG.md");
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/fanrj3/ZeroKey/releases/download/v${version}/${asset}`,
    },
  },
};
await mkdir("release", { recursive: true });
await copyFile(join(folder, asset), join("release", asset));
await copyFile(join(folder, asset + ".sig"), join("release", asset + ".sig"));
await writeFile(
  "release/latest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile("release/notes.md", notes + "\n");
const checksums = [];
for (const name of [asset, asset + ".sig", "latest.json"]) {
  checksums.push(
    `${createHash("sha256")
      .update(await readFile(join("release", name)))
      .digest("hex")}  ${name}`,
  );
}
await writeFile("release/SHA256SUMS.txt", checksums.join("\n") + "\n");
console.log(`Prepared v${version} release assets and signed updater manifest.`);
