#!/usr/bin/env node
// Print a mergeable snippet; never overwrite an Agent's existing configuration.
import { scriptPath, runtimeBinary } from "./broker-client.ts";

const client = process.argv[2] ?? "codex";
const entry = scriptPath("mcp");
const node = runtimeBinary();
if (client === "codex") {
  console.log(
    `[mcp_servers.zerokey]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(entry)}]\n`,
  );
} else if (client === "claude") {
  console.log(
    JSON.stringify(
      { mcpServers: { zerokey: { command: node, args: [entry] } } },
      null,
      2,
    ),
  );
} else if (client === "opencode") {
  console.log(
    JSON.stringify(
      {
        mcp: {
          zerokey: {
            type: "local",
            command: [node, entry],
            enabled: true,
          },
        },
      },
      null,
      2,
    ),
  );
} else {
  console.error("Usage: node scripts/mcp-config.ts codex|claude|opencode");
  process.exitCode = 1;
}
