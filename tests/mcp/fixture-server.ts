// Test-only MCP entrypoint; production has no fixture flags or credential bypasses.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../../scripts/mcp-server.ts";
const id = "3f8f79b4-0a8e-4aaa-8be0-e0011f930cc1";
const secret = "sk-fixture-do-not-return";
const project = {
  id: "project",
  name: "demo",
  path: process.cwd(),
  models: ["source/approved"],
  dailyBudget: 0.5,
  duration: null,
  expires: null,
  createdAt: "2026-11-17T00:00:00Z",
  status: "active",
  keyHash: secret,
  apiKey: secret,
};
let state = "pending";
serveStdio(() =>
  createServer(async (action, body = {}) => {
    if (action === "doctor")
      return {
        connected: true,
        desktopRunning: true,
        brokerVersion: "0.2.0",
        checkedAt: "now",
        masterKey: secret,
        connectionError: secret,
      };
    if (action === "models")
      return {
        models: Array.from({ length: 25 }, (_, i) => ({
          id:
            i === 24
              ? "source/approved"
              : `source/model-${String(i).padStart(2, "0")}`,
          source: "source",
          protocol: "responses",
          apiKey: secret,
        })),
        checkedAt: "now",
        upstreamKey: secret,
      };
    if (action === "status") {
      if (String(body.path).includes("failure")) throw new Error(secret);
      const status = String(body.path).endsWith("/unavailable")
        ? "unavailable"
        : "active";
      return {
        status,
        project: { ...project, status },
        credentialPresent: true,
        checkedAt: "now",
        key: secret,
      };
    }
    if (action === "request") {
      if (
        !Array.isArray(body.models) ||
        body.models[0] !== "source/a" ||
        body.models[1] !== "source/z" ||
        body.duration !== null ||
        body.dailyBudget !== (body.name === "large-budget" ? 100 : 1)
      )
        throw new Error("unexpected normalized input");
      state = "pending";
      return {
        requestId: id,
        status: state,
        requestedAt: 100,
        expiresAt: 700,
        projectPath: process.cwd(),
        project: null,
        key: secret,
      };
    }
    if (action === "request-cancel") state = "canceled";
    if (body.requestId === "3f8f79b4-0a8e-4aaa-8be0-e0011f930cc2")
      return {
        requestId: body.requestId,
        status: "provisioned",
        project,
        key: secret,
        changes: [{ field: "dailyBudget", requested: 1, approved: 0.5 }],
      };
    if (body.requestId === "3f8f79b4-0a8e-4aaa-8be0-e0011f930cc3")
      return {
        requestId: body.requestId,
        status: "authorizing",
        project: null,
        key: secret,
      };
    return {
      requestId: id,
      status: state,
      project: state === "canceled" ? null : project,
      key: secret,
    };
  }),
);
