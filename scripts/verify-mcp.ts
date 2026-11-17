#!/usr/bin/env node
// Real, non-issuing smoke check. No native authentication or model calls.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TestClient } from "../tests/mcp/client.ts";
import { root } from "./broker-client.ts";

const projectPath = join(root, "examples", "mcp-smoke");
await mkdir(projectPath, { recursive: true });
let client = new TestClient();
let requestId: string | undefined;
try {
  await client.initialize();
  const tools = await client.request("tools/list");
  assert.equal(tools.tools.length, 8);
  const health = (await client.call("zerokey_health")).structuredContent;
  assert.equal(health.connected, true, "Gateway must be connected");
  const first = (await client.call("zerokey_list_models", { limit: 20 }))
    .structuredContent;
  assert.ok(first.models.length > 0);
  assert.ok(first.total >= first.models.length);
  const matching = (
    await client.call("zerokey_list_models", {
      query: "gpt-4o-mini-2024-07-18",
      limit: 1,
    })
  ).structuredContent;
  const model = matching.models[0]?.id ?? first.models[0].id;
  const status = (await client.call("zerokey_project_status", { projectPath }))
    .structuredContent;
  assert.equal(
    status.status,
    "not_configured",
    "Use a fresh smoke project without a real grant",
  );
  const input = {
    projectPath,
    appName: "MCP 自动测试（无需批准）",
    models: [model],
    dailyBudget: 0.1,
  };
  if (!health.desktopRunning) {
    const result = await client.call("zerokey_request_access", input);
    assert.equal(result.structuredContent.error.code, "DESKTOP_NOT_RUNNING");
    console.log(
      JSON.stringify({
        tools: 8,
        connected: true,
        models: first.total,
        desktopRunning: false,
        offlineApprovalRejected: true,
      }),
    );
  } else {
    const request = await client.call("zerokey_request_access", input);
    assert.equal(request.structuredContent.status, "pending");
    requestId = request.structuredContent.requestId;
    const duplicate = await client.call("zerokey_request_access", input);
    assert.equal(duplicate.structuredContent.requestId, requestId);
    const conflict = await client.call("zerokey_request_access", {
      ...input,
      dailyBudget: 0.2,
    });
    assert.equal(conflict.structuredContent.error.code, "REQUEST_CONFLICT");
    await client.close();
    client = new TestClient();
    await client.initialize();
    assert.equal(
      (await client.call("zerokey_request_status", { requestId }))
        .structuredContent.status,
      "pending",
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await client.call("zerokey_cancel_request", { requestId }))
          .structuredContent.status,
        "canceled",
      );
    assert.equal(
      (await client.call("zerokey_request_status", { requestId }))
        .structuredContent.status,
      "canceled",
    );
    const unchanged = (
      await client.call("zerokey_project_status", { projectPath })
    ).structuredContent;
    assert.equal(unchanged.status, "not_configured");
    console.log(
      JSON.stringify({
        tools: 8,
        connected: true,
        models: first.total,
        desktopRunning: true,
        requestDeduplicated: true,
        conflictRejected: true,
        reconnected: true,
        canceled: true,
        noGrantCreated: true,
      }),
    );
    requestId = undefined;
  }
} finally {
  if (requestId)
    await client.call("zerokey_cancel_request", { requestId }).catch(() => {});
  await client.close();
}
