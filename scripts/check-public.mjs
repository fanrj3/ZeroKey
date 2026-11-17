// Prints paths only; secret values and client configurations must never enter logs.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const secrets = existsSync(".env")
  ? readFileSync(".env", "utf8")
      .split(/\r?\n/)
      .filter((line) =>
        /^[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*=/.test(line),
      )
      .map((line) => line.slice(line.indexOf("=") + 1).trim())
      .filter((value) => value.length >= 16)
  : [];
const rejected = [];
for (const path of paths) {
  if (
    (/(^|\/)\.env($|\.)/.test(path) && path !== ".env.example") ||
    /\.(key|pem|pfx|p12)$/.test(path)
  ) {
    rejected.push(path);
    continue;
  }
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  if (
    secrets.some((value) => text.includes(value)) ||
    /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{24,})\b/.test(
      text,
    )
  )
    rejected.push(path);
}
if (rejected.length) {
  console.error("Potential private material in tracked files:");
  rejected.forEach((path) => console.error(path));
  process.exitCode = 1;
} else
  console.log(
    `Public-source check passed for ${paths.length} tracked files; no local secrets matched.`,
  );
