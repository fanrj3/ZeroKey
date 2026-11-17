import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectConfig,
  mergeConfig,
  manageConfig,
} from "../../scripts/integration-config.ts";

test("client installers preserve unrelated config and comments, are idempotent and back up existing files", () => {
  const directory = mkdtempSync(join(tmpdir(), "zerokey-config-test-"));
  try {
    for (const client of ["codex", "claude", "opencode"] as const) {
      const text =
        client === "codex"
          ? '# keep this comment\nmodel = "synthetic"\n[mcp_servers.other]\ncommand = "keep"\n'
          : '{\n // keep this comment\n "unrelated": { "token": "synthetic-private-value" }\n}';
      const path = join(directory, client + ".config");
      writeFileSync(path, text);
      const result = manageConfig(client, true, directory, path);
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(readFileSync(result.backup!, "utf8"), text);
      const next = readFileSync(path, "utf8");
      assert.ok(next.includes("keep this comment"));
      assert.equal(mergeConfig(client, next), next);
      assert.ok(!JSON.stringify(result).includes("synthetic-private-value"));
      assert.equal(inspectConfig(client, next).configured, true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid or conflicting client entries are not overwritten or reported as configured", () => {
  assert.throws(
    () => mergeConfig("codex", '[mcp_servers.zerokey]\ncommand="different"\n'),
    /ENTRY_CONFLICT/,
  );
  assert.throws(() => mergeConfig("opencode", "{ broken"), /CONFIG_INVALID/);
});
