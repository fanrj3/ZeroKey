import assert from "node:assert/strict";
import { test } from "node:test";
import { TestClient } from "./client.ts";

const id = "3f8f79b4-0a8e-4aaa-8be0-e0011f930cc1";
async function fixture(t: any) {
  const client = new TestClient("tests/mcp/fixture-server.ts");
  t.after(() => client.close());
  await client.initialize();
  return client;
}

test("stdio initializes, discovers eight tools and shuts down on EOF", async (t) => {
  const client = await fixture(t);
  const list = await client.request("tools/list");
  assert.equal(list.tools.length, 8);
  assert.ok(
    list.tools.every(
      (tool: any) =>
        !tool.name.includes("run") && !tool.name.includes("approve"),
    ),
  );
  const result = await client.call("zerokey_health");
  assert.equal(result.structuredContent.connected, true);
  assert.ok(!JSON.stringify(result).includes("sk-fixture"));
});
test("pagination keeps provider/protocol and strips unapproved output fields", async (t) => {
  const client = await fixture(t);
  const first = (await client.call("zerokey_list_models")).structuredContent;
  assert.equal(first.models.length, 20);
  assert.equal(first.nextCursor, "20");
  const second = (
    await client.call("zerokey_list_models", { cursor: first.nextCursor })
  ).structuredContent;
  assert.equal(second.models.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(second.models[0].protocol, "responses");
  assert.equal(second.models[0].source, "source");
  assert.ok(!JSON.stringify([first, second]).includes("sk-fixture"));
  assert.equal(
    (await client.call("zerokey_list_models", { source: "missing" }))
      .structuredContent.total,
    0,
  );
});
test("secrets and unknown fields rejected before any approval operation", async (t) => {
  const client = await fixture(t);
  const input = {
    projectPath: process.cwd(),
    appName: "demo",
    models: ["source/a"],
  };
  for (const extra of [
    { pin: "123456" },
    { masterKey: "secret" },
    { models: ["*"] },
    { dailyBudget: 11 },
    { duration: "2m" },
    { projectPath: "relative" },
  ]) {
    const result = await client.call("zerokey_request_access", {
      ...input,
      ...extra,
    });
    assert.equal(result.isError, true);
  }
  assert.equal(
    (await client.call("zerokey_list_models", { limit: 101 })).isError,
    true,
  );
});
test("request normalized, queried and canceled without blocking or exposing keys", async (t) => {
  const client = await fixture(t);
  const response = await client.call("zerokey_request_access", {
    projectPath: process.cwd(),
    appName: "demo",
    models: ["source/z", "source/a", "source/a"],
  });
  assert.equal(response.structuredContent.status, "pending");
  assert.equal(response.structuredContent.requestId, id);
  assert.equal(
    (await client.call("zerokey_request_status", { requestId: id }))
      .structuredContent.status,
    "pending",
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await client.call("zerokey_cancel_request", { requestId: id }))
        .structuredContent.status,
      "canceled",
    );
  assert.ok(!JSON.stringify(response).includes("sk-fixture"));
});
test("existing authorization returns launcher and final scope, never credentials", async (t) => {
  const client = await fixture(t);
  const result = await client.call("zerokey_project_status", {
    projectPath: process.cwd(),
  });
  assert.equal(result.structuredContent.project.models[0], "source/approved");
  assert.equal(result.structuredContent.launcher.command, process.execPath);
  assert.equal(result.structuredContent.launcher.args.at(-1), "--");
  assert.ok(!JSON.stringify(result).includes("keyHash"));
  assert.ok(!JSON.stringify(result).includes("sk-fixture"));
});
test("untrusted broker errors cannot echo sensitive diagnostic text", async (t) => {
  const client = await fixture(t);
  const result = await client.call("zerokey_project_status", {
    projectPath: process.cwd() + "/failure",
  });
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes("sk-fixture"));
  const health = await client.call("zerokey_health");
  assert.equal(health.structuredContent.connected, true);
});
test("approval reports actual granted scope and authentication cannot falsely cancel", async (t) => {
  const client = await fixture(t);
  const approved = await client.call("zerokey_request_status", {
    requestId: "3f8f79b4-0a8e-4aaa-8be0-e0011f930cc2",
  });
  assert.equal(approved.structuredContent.status, "provisioned");
  assert.equal(approved.structuredContent.project.dailyBudget, 0.5);
  assert.deepEqual(approved.structuredContent.changeSummary, [
    "每日预算：$1.00 → $0.50",
  ]);
  assert.deepEqual(approved.structuredContent.project.models, [
    "source/approved",
  ]);
  assert.ok(approved.structuredContent.launcher);
  const busy = await client.call("zerokey_cancel_request", {
    requestId: "3f8f79b4-0a8e-4aaa-8be0-e0011f930cc3",
  });
  assert.equal(busy.structuredContent.status, "authorizing");
  assert.equal(busy.structuredContent.launcher, undefined);
});

test("wait keeps the original request identity and setup returns a credential-free runnable template", async (t) => {
  const client = await fixture(t);
  const result = await client.call("zerokey_wait_request", {
    requestId: id,
    timeoutSeconds: 1,
  });
  assert.equal(result.structuredContent.requestId, id);
  const setup = await client.call("zerokey_project_setup", {
    projectPath: process.cwd(),
  });
  assert.equal(setup.isError, undefined);
  assert.equal(setup.structuredContent.files.length, 2);
  assert.ok(setup.structuredContent.verify.args.includes("--model"));
  assert.ok(!JSON.stringify(setup).includes("sk-fixture"));
});
test("real entrypoint starts and lists tools without a gateway or desktop dependency", async (t) => {
  const client = new TestClient();
  t.after(() => client.close());
  await client.initialize("2025-03-26");
  assert.equal((await client.request("tools/list")).tools.length, 8);
});
