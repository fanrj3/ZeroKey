// Verifies the shipped layout from a path unrelated to the source checkout.
import assert from "node:assert/strict";
import { mkdtemp, cp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const source = resolve(process.argv[2] ?? "src-tauri/target/release");
const folder = await mkdtemp(join(tmpdir(), "zerokey-package-"));
let child;
try {
  for (const name of ["agent", "runtime", "zerokey.exe"])
    await cp(join(source, name), join(folder, name), { recursive: true });
  const node = join(folder, "runtime/node.exe");
  const config = spawnSync(
    node,
    [join(folder, "agent/mcp-config.mjs"), "claude"],
    { encoding: "utf8", windowsHide: true, cwd: folder },
  );
  assert.equal(config.status, 0);
  const entry = JSON.parse(config.stdout).mcpServers.zerokey;
  assert.notEqual(
    entry.command,
    node,
    "MCP runtime must not lock installed Node during updates",
  );
  assert.ok(entry.command.includes("app.zerokey.desktop"));
  assert.deepEqual(entry.args, [join(folder, "agent/mcp.mjs")]);
  const cli = spawnSync(node, [join(folder, "agent/zerokey.mjs"), "doctor"], {
    encoding: "utf8",
    windowsHide: true,
    cwd: folder,
  });
  assert.ok(
    !cli.error && !cli.stderr.includes("BROKER_NOT_BUILT"),
    "packaged CLI must find native broker",
  );
  const isolatedConfig = join(folder, "test-config");
  await mkdir(isolatedConfig);
  const integration = spawnSync(
    node,
    [join(folder, "agent/integration.mjs"), "codex", "install", isolatedConfig],
    {
      encoding: "utf8",
      windowsHide: true,
      cwd: folder,
      env: { ...process.env, CODEX_HOME: isolatedConfig },
    },
  );
  assert.equal(integration.status, 0);
  assert.equal(JSON.parse(integration.stdout).configured, true);
  assert.ok(JSON.parse(integration.stdout).snippet.includes("mcp.mjs"));
  child = spawn(entry.command, entry.args, {
    cwd: folder,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let sequence = 0;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const wait = pending.get(message.id);
    if (wait) {
      pending.delete(message.id);
      clearTimeout(wait.timer);
      wait.resolve(message);
    }
  });
  const request = (method, params) =>
    new Promise((resolveResult, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("MCP timeout"));
      }, 15000);
      pending.set(id, { resolve: resolveResult, timer });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const init = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "zerokey-package-check", version: "1.0" },
  });
  assert.ok(init.result?.serverInfo);
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  const listed = await request("tools/list", {});
  assert.equal(listed.result?.tools.length, 8);
  child.stdin.end();
  await new Promise((done) => {
    child.once("exit", done);
    setTimeout(() => {
      child.kill();
      done();
    }, 2000).unref();
  });
  console.log(
    "Packaged runtime: isolated CLI, client configuration, MCP handshake and 8 tools passed.",
  );
} finally {
  if (child && child.exitCode === null) child.kill();
  await rm(folder, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
