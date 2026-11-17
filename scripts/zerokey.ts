#!/usr/bin/env node
// Node 22.18+ runs TypeScript with native type stripping; no Python dependency.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brokerBinary, callBroker } from "./broker-client.ts";
import { projectSetup } from "./project-template.ts";
const args = process.argv.slice(2);
const action = args.shift() ?? "doctor";
const supported = [
  "models",
  "doctor",
  "status",
  "provision",
  "run",
  "request",
  "request-status",
  "request-cancel",
  "request-wait",
  "init",
  "verify",
  "revoke",
];
if (!supported.includes(action)) {
  console.error(
    "Usage: node scripts/zerokey.ts models|doctor|status|provision|run|request|request-status|request-cancel|request-wait|init|verify|revoke [options]\nModels: --source <provider> --query <name> --limit <1-100> --cursor <offset>\nProject: --project <folder> [--model <id>] [-- program args]\nRequest: --app <name> --models <ids> --budget <USD/day> [--duration 7d] [--reason <text>]\nWait: --request-id <id> --after-status pending|authorizing --timeout <1-30>",
  );
  process.exit(1);
}
const body: Record<string, unknown> = {
  models: ["opencode-go/gpt-6-luna"],
  dailyBudget: 1,
  duration: null,
};
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  if (option === "--") {
    body.program = args.slice(index + 1);
    break;
  }
  const value = args[++index];
  if (!value) {
    console.error(`Missing value for ${option}`);
    process.exit(1);
  }
  if (option === "--project") body.path = resolve(value);
  else if (option === "--app") body.name = value;
  else if (option === "--models")
    body.models = value.split(",").filter(Boolean);
  else if (option === "--budget") body.dailyBudget = Number(value);
  else if (option === "--duration") body.duration = value;
  else if (option === "--session-id") body.sessionId = value;
  else if (option === "--request-id") body.requestId = value;
  else if (option === "--reason")
    body.reasons = [...((body.reasons as string[] | undefined) ?? []), value];
  else if (option === "--model") body.model = value;
  else if (option === "--source") body.source = value;
  else if (option === "--query") body.query = value;
  else if (option === "--limit") body.limit = Number(value);
  else if (option === "--cursor") body.cursor = value;
  else if (option === "--timeout") body.timeoutSeconds = Number(value);
  else if (option === "--after-status") body.afterStatus = value;
  else {
    console.error(`Unknown option: ${option}`);
    process.exit(1);
  }
}
if (typeof body.path === "string" && !body.name)
  body.name = body.path.split(/[\\/]/).filter(Boolean).pop();
let binary: string;
try {
  binary = brokerBinary();
} catch {
  console.error(
    "Build the desktop app first: npm run desktop:build -- --debug --no-bundle",
  );
  process.exit(1);
}
if (action === "models") {
  try {
    const { models, checkedAt } = (await callBroker("models")) as any;
    const offset = Number(body.cursor ?? 0),
      limit = Number(body.limit ?? 20);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("分页参数需为非负游标和 1–100 条。");
    const matches = models.filter(
      (m: any) =>
        (!body.source || m.source === body.source) &&
        (!body.query ||
          m.id.toLowerCase().includes(String(body.query).toLowerCase())),
    );
    console.log(
      JSON.stringify(
        {
          models: matches.slice(offset, offset + limit),
          total: matches.length,
          nextCursor:
            offset + limit < matches.length ? String(offset + limit) : null,
          checkedAt,
          catalogOnly: true,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  } catch {
    console.error(
      "模型目录读取失败，请运行 doctor 检查网关；分页使用 --cursor 0 --limit 20。",
    );
    process.exit(1);
  }
}
if (action === "init" || action === "verify") {
  try {
    const setup = await projectSetup(
      callBroker,
      String(body.path ?? process.cwd()),
      body.model as string | undefined,
    );
    const targets = setup.files.map((file) => ({
      ...file,
      target: join(setup.projectPath, file.path),
    }));
    if (targets.some((file) => existsSync(file.target))) {
      if (action === "init")
        throw new Error("模板已存在，未覆盖；可用 verify 验证已有接入。");
      if (!targets.every((file) => existsSync(file.target)))
        throw new Error("接入模板不完整，请检查 .zerokey 目录。");
    } else {
      for (const file of targets) {
        mkdirSync(dirname(file.target), { recursive: true });
        writeFileSync(file.target, file.content, { flag: "wx", mode: 0o600 });
      }
    }
    if (action === "init") {
      console.log(
        JSON.stringify(
          {
            status: "ready",
            projectPath: setup.projectPath,
            model: setup.model,
            protocol: setup.protocol,
            verify: setup.verify,
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    // Use the same native launcher as all project runs. No credentials in this process.
    body.model = setup.model;
    body.path = setup.projectPath;
    body.program = [process.execPath, ".zerokey/verify.mjs"];
  } catch (error) {
    console.error(
      error instanceof Error && !/^[A-Z_]+$/.test(error.message)
        ? error.message
        : "接入未就绪，请检查项目授权和模型协议。",
    );
    process.exit(1);
  }
}
const child = spawn(
  binary,
  ["--broker", action === "verify" ? "run" : action, JSON.stringify(body)],
  {
    stdio: "inherit",
    windowsHide: true,
  },
);
child.on("error", () => {
  console.error("Could not start the ZeroKey broker.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
process.on("SIGINT", () => child.kill());
