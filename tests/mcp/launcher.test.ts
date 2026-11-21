import assert from "node:assert/strict";
import { after, test } from "node:test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Exercise the actual CLI parser and exit forwarding without credentials or a gateway.
const cache = resolve(".npm-cache");
mkdirSync(cache, { recursive: true });
const folder = mkdtempSync(join(cache, "zerokey-launch-"));
const entry = join(folder, "cli.mjs");
after(() => rmSync(folder, { recursive: true, force: true }));
const bundled = await build({
  entryPoints: ["scripts/zerokey.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  banner: {
    js: `for (const name of ["stdin","stdout","stderr"]) Object.defineProperty(process[name],"isTTY",{value:(process.env.ZEROKEY_TEST_TTY??"").split(",").includes(name)});`,
  },
  plugins: [
    {
      name: "synthetic-launcher",
      setup(builder) {
        builder.onResolve({ filter: /broker-client\.ts$/ }, () => ({
          path: "broker",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /^node:child_process$/ }, () => ({
          path: "spawn",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents:
            path === "broker"
              ? `
      export const brokerBinary=()=>"synthetic-broker";
      export const scriptPath=name=>name;
      export const runtimeBinary=()=>process.execPath;
      export const callBroker=async action=>action==="status"?{status:"active",credentialPresent:true,project:{path:process.cwd(),models:["test/model"]}}:{models:[{id:"test/model",protocol:"chat-completions"}]};
    `
              : `import{EventEmitter}from"node:events";
      export function spawn(binary,args,options){const child=new EventEmitter();child.kill=()=>true;process.stdout.write(JSON.stringify({binary,args,options}));process.nextTick(()=>child.emit("exit",23));return child;}
    `,
        }));
      },
    },
  ],
});
writeFileSync(entry, bundled.outputFiles[0].text);
function run(options: string[], tty = "") {
  return spawnSync(process.execPath, [entry, ...options], {
    encoding: "utf8",
    windowsHide: true,
    cwd: folder,
    env: { ...process.env, ZEROKEY_TEST_TTY: tty },
  });
}
function launch(options: string[], tty = "") {
  const result = run(["run", "--project", folder, ...options], tty);
  assert.equal(result.status, 23, result.stderr);
  const launched = JSON.parse(result.stdout);
  assert.equal(launched.args[0], "--broker");
  assert.equal(launched.args[1], "run");
  assert.equal(launched.options.stdio, "inherit");
  return JSON.parse(launched.args[2]);
}
test("background CLI calls are windowless and keep child arguments and exit codes", () => {
  const body = launch([
    "--",
    "node.exe",
    "--interactive",
    "file with spaces.mjs",
  ]);
  assert.equal(body.noWindow, true);
  assert.deepEqual(body.program, [
    "node.exe",
    "--interactive",
    "file with spaces.mjs",
  ]);
  assert.equal(body.path, resolve(folder));
});
test("terminal CLI calls retain legacy mode and explicit options override auto detection", () => {
  assert.equal(launch(["--", "node.exe"], "stdout").noWindow, false);
  assert.equal(
    launch(["--no-window", "--", "node.exe"], "stdin,stdout,stderr").noWindow,
    true,
  );
  assert.equal(launch(["--interactive", "--", "node.exe"]).noWindow, false);
});
test("conflicting modes and flags on unrelated commands are rejected before starting the broker", () => {
  for (const options of [
    ["run", "--no-window", "--interactive"],
    ["status", "--no-window"],
  ]) {
    const result = run(options);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /cannot be combined|only supported by run and verify/,
    );
  }
});
test("verify chooses windowless execution even from a terminal", () => {
  const result = run(["verify", "--project", folder], "stdin,stdout,stderr");
  assert.equal(result.status, 23, result.stderr);
  const body = JSON.parse(JSON.parse(result.stdout).args[2]);
  assert.equal(body.noWindow, true);
  assert.equal(body.program.at(-1), ".zerokey/verify.mjs");
});
