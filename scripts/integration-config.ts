import {
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc, modify, applyEdits } from "jsonc-parser";
import { scriptPath, runtimeBinary } from "./broker-client.ts";

export const clients = ["codex", "claude", "opencode"] as const;
export type ClientName = (typeof clients)[number];
export function configPath(client: ClientName) {
  if (client === "codex")
    return join(
      process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      "config.toml",
    );
  if (client === "claude") return join(homedir(), ".claude.json");
  const directory = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "opencode",
  );
  return join(
    directory,
    existsSync(join(directory, "opencode.jsonc"))
      ? "opencode.jsonc"
      : "opencode.json",
  );
}
export function entryFor(client: ClientName) {
  const entry = scriptPath("mcp");
  return client === "opencode"
    ? { type: "local", command: [runtimeBinary(), entry], enabled: true }
    : { command: runtimeBinary(), args: [entry] };
}
export function inspectConfig(client: ClientName, text: string) {
  let value: any;
  if (client === "codex") value = parseToml(text).mcp_servers;
  else {
    const errors: any[] = [];
    const parsed = parseJsonc(text || "{}", errors, {
      allowTrailingComma: true,
    });
    if (
      errors.length ||
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    )
      throw new Error("CONFIG_INVALID");
    value = client === "claude" ? parsed.mcpServers : parsed.mcp;
  }
  const existing = value?.zerokey;
  const desired = entryFor(client);
  const configured =
    existing &&
    (client === "opencode"
      ? JSON.stringify(existing.command) === JSON.stringify(desired.command) &&
        existing.enabled !== false
      : existing.command === desired.command &&
        JSON.stringify(existing.args) ===
          JSON.stringify("args" in desired ? desired.args : []) &&
        existing.enabled !== false);
  return { configured: !!configured, conflict: !!existing && !configured };
}
export function mergeConfig(client: ClientName, text: string) {
  const current = inspectConfig(client, text);
  if (current.conflict) throw new Error("ENTRY_CONFLICT");
  if (current.configured) return text;
  const entry = entryFor(client);
  if (client === "codex") {
    return (
      text.trimEnd() +
      `\n\n[mcp_servers.zerokey]\ncommand = ${JSON.stringify(runtimeBinary())}\nargs = [${JSON.stringify(scriptPath("mcp"))}]\n`
    );
  }
  return applyEdits(
    text || "{}",
    modify(
      text || "{}",
      [client === "claude" ? "mcpServers" : "mcp", "zerokey"],
      entry,
      { formattingOptions: { insertSpaces: true, tabSize: 2 } },
    ),
  );
}
export function manageConfig(
  client: ClientName,
  install: boolean,
  directory: string,
  path = configPath(client),
) {
  let backup: string | null = null;
  let configured = false,
    conflict = false,
    error: string | null = null;
  try {
    if (existsSync(path) && statSync(path).size > 2_000_000)
      throw new Error("CONFIG_INVALID");
    const text = existsSync(path)
      ? readFileSync(path, "utf8")
      : client === "codex"
        ? ""
        : "{}";
    ({ configured, conflict } = inspectConfig(client, text));
    if (install && !configured) {
      const next = mergeConfig(client, text);
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path)) {
        backup = `${path}.zerokey-${Date.now()}.bak`;
        copyFileSync(path, backup);
      }
      const temporary = `${path}.zerokey-${process.pid}.tmp`;
      try {
        writeFileSync(temporary, next, { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      configured = true;
    }
  } catch (e: any) {
    error = ["CONFIG_INVALID", "ENTRY_CONFLICT"].includes(e.message)
      ? e.message
      : e.code === "EACCES" || e.code === "EPERM"
        ? "CONFIG_ACCESS_DENIED"
        : "CONFIG_READ_FAILED";
  }
  // Only recent live SDK sessions count as a connected client, never the installer/probe itself.
  let connected = false,
    toolsAvailable = false;
  const folder = join(directory, "connections");
  if (existsSync(folder)) {
    for (const file of readdirSync(folder).filter((name) =>
      /^\d+\.json$/.test(name),
    )) {
      try {
        const session = JSON.parse(readFileSync(join(folder, file), "utf8"));
        if (
          Date.now() / 1000 - session.updatedAt > 45 ||
          !String(session.client).toLowerCase().includes(client)
        )
          continue;
        try {
          process.kill(session.pid, 0);
        } catch {
          continue;
        }
        connected = true;
        toolsAvailable ||= session.toolsAvailable === true;
      } catch {
        /* A partial or stale marker is not connection evidence. */
      }
    }
  }
  return {
    client,
    path,
    configured,
    conflict,
    connected,
    toolsAvailable,
    backup,
    error,
    snippet:
      client === "codex"
        ? `[mcp_servers.zerokey]\ncommand = ${JSON.stringify(runtimeBinary())}\nargs = [${JSON.stringify(scriptPath("mcp"))}]`
        : JSON.stringify(
            {
              [client === "claude" ? "mcpServers" : "mcp"]: {
                zerokey: entryFor(client),
              },
            },
            null,
            2,
          ),
  };
}
