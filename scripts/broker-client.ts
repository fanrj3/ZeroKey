import { spawn } from "node:child_process";
import {
  existsSync,
  statSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Bundled entries all live in <install>/agent; development entries live in scripts/.
const packaged = fileURLToPath(import.meta.url).endsWith(".mjs");
export function scriptPath(name: string): string {
  return join(
    root,
    packaged ? "agent" : "scripts",
    `${name}.${packaged ? "mjs" : "ts"}`,
  );
}
// Long-lived MCPs must not hold the installer's runtime file open on Windows.
export function runtimeBinary(): string {
  if (!packaged || process.platform !== "win32") return process.execPath;
  const manifest = JSON.parse(
    readFileSync(join(root, "runtime/manifest.json"), "utf8"),
  );
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256))
    throw new Error("RUNTIME_INVALID");
  const folder = join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"),
    "app.zerokey.desktop",
    "runtime",
  );
  const target = join(folder, `node-${manifest.sha256}.exe`);
  const source = join(root, "runtime/node.exe");
  mkdirSync(folder, { recursive: true });
  if (!existsSync(target) || statSync(target).size !== statSync(source).size) {
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      copyFileSync(source, temporary);
      if (
        createHash("sha256").update(readFileSync(temporary)).digest("hex") !==
        manifest.sha256
      )
        throw new Error("RUNTIME_INVALID");
      try {
        renameSync(temporary, target);
      } catch (error) {
        if (!existsSync(target)) throw error;
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  return target;
}
export function brokerBinary(): string {
  const name = process.platform === "win32" ? "zerokey.exe" : "zerokey";
  if (packaged) {
    const installed = join(root, name);
    if (!existsSync(installed)) throw new Error("BROKER_NOT_BUILT");
    return installed;
  }
  const binary = ["release", "debug"]
    .map((mode) => join(root, "src-tauri", "target", mode, name))
    .filter(existsSync)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!binary) throw new Error("BROKER_NOT_BUILT");
  return binary;
}

export type BrokerCall = (
  action: string,
  body?: Record<string, unknown>,
) => Promise<unknown>;

// No shell, inherited terminal output, or credential reads in this process.
export const callBroker: BrokerCall = async (action, body = {}) => {
  const binary = brokerBinary();
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, ["--broker", action, JSON.stringify(body)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "",
      stderr = "",
      settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveResult(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("BROKER_TIMEOUT"));
    }, 55000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) {
        child.kill();
        finish(new Error("BROKER_INVALID_RESPONSE"));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 4096);
    });
    child.on("error", () => finish(new Error("BROKER_UNAVAILABLE")));
    child.on("close", (code) => {
      if (code !== 0) {
        // Only a known symbolic code crosses into tool responses. Never echo raw stderr.
        const match = /(?:^|ZeroKey: )([A-Z_]+):/.exec(stderr);
        finish(new Error(match?.[1] ?? "BROKER_ERROR"));
      } else {
        try {
          finish(undefined, JSON.parse(stdout));
        } catch {
          finish(new Error("BROKER_INVALID_RESPONSE"));
        }
      }
    });
  });
};
