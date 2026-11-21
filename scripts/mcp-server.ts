import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isAbsolute } from "node:path";
import { callBroker, scriptPath, runtimeBinary } from "./broker-client.ts";
import type { BrokerCall } from "./broker-client.ts";
import { projectSetup } from "./project-template.ts";

const projectPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolute, "项目路径必须是绝对路径");
const requestId = z.string().uuid();
const model = z.object({
  id: z.string(),
  source: z.string(),
  protocol: z.string(),
});
const project = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  models: z.array(z.string()),
  dailyBudget: z.number(),
  duration: z.string().nullable(),
  expires: z.string().nullable(),
  createdAt: z.string(),
  status: z.string(),
  reasons: z.array(z.string()).optional(),
});
const statusResult = z.object({
  status: z.string(),
  path: z.string().optional(),
  project: project.optional(),
  credentialPresent: z.boolean().optional(),
  checkedAt: z.string(),
});
const requestResult = z
  .object({
    status: z.enum([
      "pending",
      "authorizing",
      "provisioned",
      "reused",
      "canceled",
      "expired",
      "failed",
    ]),
    requestId: requestId.optional(),
    requestedAt: z.number().optional(),
    expiresAt: z.number().optional(),
    projectPath: z.string().optional(),
    project: project.nullable().optional(),
    checkedAt: z.string().optional(),
    message: z
      .unknown()
      .optional()
      .transform((value) =>
        typeof value === "string" &&
        [
          "审批进程已中断，请在桌面检查项目状态后再操作。",
          "签发或保存未完成，请在桌面检查项目与网关状态。",
          "授权已保存，但后续清理未完成，请在桌面和 LiteLLM 检查旧凭证。",
        ].includes(value)
          ? value
          : undefined,
      ),
    changes: z
      .array(
        z.object({
          field: z.enum([
            "dailyBudget",
            "models",
            "duration",
            "path",
            "reasons",
          ]),
          requested: z.union([
            z.number(),
            z.string(),
            z.array(z.string()),
            z.null(),
          ]),
          approved: z.union([
            z.number(),
            z.string(),
            z.array(z.string()),
            z.null(),
          ]),
        }),
      )
      .default([]),
  })
  .superRefine((value, ctx) => {
    if (value.status !== "reused" && !value.requestId)
      ctx.addIssue({ code: "custom", message: "Missing request identity" });
    if (["reused", "provisioned"].includes(value.status) && !value.project)
      ctx.addIssue({ code: "custom", message: "Missing approved scope" });
  });
const errors: Record<string, string> = {
  BROKER_NOT_BUILT: "请先构建 ZeroKey 桌面应用。",
  BROKER_UNAVAILABLE: "无法启动本机 Broker。",
  BROKER_TIMEOUT: "本机操作未及时完成，请查询原申请状态，不要重复申请。",
  BROKER_INVALID_RESPONSE:
    "Broker 返回了无法识别的数据，请更新并重启 ZeroKey。",
  BROKER_ERROR: "本机操作失败，请在 ZeroKey 检查网关连接和项目状态。",
  BROKER_BUSY: "另一个授权操作正在进行，请稍后查询。",
  DESKTOP_NOT_RUNNING: "请先启动 ZeroKey（托盘驻留即可），再提交申请。",
  PROJECT_NOT_FOUND: "项目文件夹不存在。",
  INVALID_INPUT: "请检查项目、模型、每日预算与期限。",
  REQUEST_CONFLICT: "此项目已有不同范围的申请，请先查询或取消原申请。",
  REQUEST_NOT_FOUND: "找不到申请，或结果已超过 24 小时保留期。",
  INVALID_REQUEST_ID: "申请编号无效。",
  MODEL_UNAVAILABLE: "所选模型不在当前网关目录中。",
  GATEWAY_UNAVAILABLE: "无法连接网关，请在 ZeroKey 检查连接。",
  CREDENTIAL_MISSING: "本机凭证缺失，请在 ZeroKey 检查连接或重新授权。",
  CONFIG_ACCESS_DENIED:
    "当前进程无法读取本机配置；请在正常桌面会话中运行同一命令，无需重新授权。",
  CONFIG_NOT_FOUND: "尚未保存网关配置，请从托盘打开设置并连接 LiteLLM。",
  CONFIG_READ_FAILED: "无法读取本机配置，请打开 ZeroKey 设置检查文件权限。",
  CONFIG_INVALID: "本机网关配置格式不正确，请打开设置重新连接。",
  PROJECT_NOT_READY: "项目还没有可用授权；先查询或完成原申请，再生成接入模板。",
  TEMPLATE_PROTOCOL_UNSUPPORTED:
    "当前授权中没有模板支持的 Chat Completions 或 Responses 模型；请按目录协议适配。",
  STORAGE_ERROR: "无法读写本机申请状态，请检查应用数据目录权限。",
};

function success(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}
async function guarded(work: () => Promise<Record<string, unknown>>) {
  try {
    return success(await work());
  } catch (error) {
    const candidate = error instanceof Error ? error.message : "";
    const code = Object.hasOwn(errors, candidate)
      ? candidate
      : "BROKER_INVALID_RESPONSE";
    return {
      ...success({ error: { code, message: errors[code] } }),
      isError: true,
    };
  }
}
function withLauncher(
  value: z.infer<typeof requestResult> | z.infer<typeof statusResult>,
) {
  const ready =
    value.project &&
    (value.status === "reused" ||
      value.status === "provisioned" ||
      (value.status === "active" &&
        "credentialPresent" in value &&
        value.credentialPresent));
  return {
    ...value,
    ...("changes" in value
      ? {
          changeSummary: value.changes.map(({ field, requested, approved }) => {
            const labels = {
              dailyBudget: "每日预算",
              models: "授权模型",
              duration: "有效期",
              path: "授权项目",
              reasons: "授权理由",
            };
            const format = (v: typeof requested) =>
              field === "dailyBudget" && typeof v === "number"
                ? `$${v.toFixed(2)}`
                : v === null
                  ? "长期有效"
                  : Array.isArray(v)
                    ? v.join("、")
                    : String(v);
            return `${labels[field]}：${format(requested)} → ${format(approved)}`;
          }),
        }
      : {}),
    ...(ready
      ? {
          launcher: {
            command: runtimeBinary(),
            args: [
              scriptPath("zerokey"),
              "run",
              "--no-window",
              "--project",
              value.project!.path,
              "--",
            ],
            instruction:
              "在参数末尾追加程序与参数。后台运行不创建 Windows 控制台；交互式终端任务可将 --no-window 改为 --interactive。凭证只注入子进程，勿打印环境。OpenCode Go 请求使用 LITELLM_SESSION_ID 作为 x-litellm-session-id。",
          },
        }
      : {}),
    ...("requestId" in value && value.status === "pending"
      ? {
          nextAction:
            "请用户在 ZeroKey 独立窗口审核；托盘驻留即可。使用 zerokey_wait_request 等待同一 requestId，取消或过期后停止，不自动重提。",
        }
      : {}),
  };
}

export function createServer(broker: BrokerCall = callBroker) {
  const server = new McpServer(
    { name: "zerokey", version: "0.3.0" },
    {
      instructions:
        "ZeroKey 管理项目模型授权。先查 project_status 并复用足够的有效授权；需要时才申请新范围，每次一个项目。默认长期有效，预算为美元/日。托盘驻留时独立审核窗口会弹出；由用户确认并完成本机验证，勿收集 PIN 或 Key。使用 wait_request 等待同一申请，取消/过期后停止。报告 changeSummary 和最终获批范围。获批后用 project_setup 接入模板、通过终端执行验证，推进到首次文字调用成功。MCP 不返回凭证，不执行命令。模型目录不保证可用，Go 不自动转付费。",
    },
  );
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  server.registerTool(
    "zerokey_health",
    {
      description: "检查网关和桌面是否可审核申请，无凭证返回。",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    () =>
      guarded(async () => {
        const health = z
          .object({
            connected: z.boolean(),
            desktopRunning: z.boolean(),
            brokerVersion: z.string(),
            checkedAt: z.string(),
            connectionError: z
              .unknown()
              .optional()
              .transform((value) =>
                typeof value === "string" && Object.hasOwn(errors, value)
                  ? value
                  : value == null
                    ? null
                    : "GATEWAY_UNAVAILABLE",
              ),
          })
          .parse(await broker("doctor"));
        return health;
      }),
  );
  server.registerTool(
    "zerokey_list_models",
    {
      description: "分页查询目录，保留来源/协议；列出不代表已验证调用成功。",
      annotations: readOnly,
      inputSchema: z
        .object({
          source: z.string().max(200).optional(),
          query: z.string().max(200).optional(),
          cursor: z
            .string()
            .regex(/^\d{1,9}$/)
            .optional(),
          limit: z.number().int().min(1).max(100).default(20),
        })
        .strict(),
    },
    (args) =>
      guarded(async () => {
        const catalog = z
          .object({ models: z.array(model), checkedAt: z.string() })
          .parse(await broker("models"));
        const query = args.query?.toLowerCase();
        const models = catalog.models.filter(
          (m) =>
            (!args.source || m.source === args.source) &&
            (!query || m.id.toLowerCase().includes(query)),
        );
        const offset = Number(args.cursor ?? 0),
          end = offset + args.limit;
        return {
          models: models.slice(offset, end),
          total: models.length,
          nextCursor: end < models.length ? String(end) : null,
          checkedAt: catalog.checkedAt,
          catalogOnly: true,
        };
      }),
  );
  server.registerTool(
    "zerokey_project_status",
    {
      description:
        "查询项目实际授权与凭证存在状态；不返回 Key。预算可用性由网关决定。",
      annotations: readOnly,
      inputSchema: z.object({ projectPath }).strict(),
    },
    (args) =>
      guarded(async () =>
        withLauncher(
          statusResult.parse(
            await broker("status", { path: args.projectPath }),
          ),
        ),
      ),
  );
  server.registerTool(
    "zerokey_request_access",
    {
      description:
        "申请或复用项目模型权限。立即返回 reused 或 pending；新权限须用户桌面确认。默认长期有效，审批窗口十分钟。",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z
        .object({
          projectPath,
          appName: z.string().trim().min(1).max(100),
          models: z
            .array(
              z
                .string()
                .min(1)
                .max(300)
                .refine((m) => !m.includes("*")),
            )
            .min(1)
            .max(100),
          dailyBudget: z.number().positive().default(1),
          duration: z
            .string()
            .regex(/^[1-9]\d{0,8}[dh]$/)
            .nullable()
            .optional(),
          reasons: z
            .array(z.string().trim().min(1).max(150))
            .max(8)
            .default([]),
        })
        .strict(),
    },
    (args) =>
      guarded(async () =>
        withLauncher(
          requestResult.parse(
            await broker("request", {
              path: args.projectPath,
              name: args.appName,
              models: [...new Set(args.models)].sort(),
              dailyBudget: args.dailyBudget,
              duration: args.duration ?? null,
              reasons: args.reasons,
            }),
          ),
        ),
      ),
  );
  server.registerTool(
    "zerokey_request_status",
    {
      description: "按原申请编号查询，终态保留24小时；成功返回最终获批范围。",
      annotations: readOnly,
      inputSchema: z.object({ requestId }).strict(),
    },
    (args) =>
      guarded(async () =>
        withLauncher(
          requestResult.parse(
            await broker("request-status", { requestId: args.requestId }),
          ),
        ),
      ),
  );
  server.registerTool(
    "zerokey_cancel_request",
    {
      description:
        "幂等取消待审核申请。正在验证/签发时返回 authorizing，必须等待确定终态；不伪报已取消。",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({ requestId }).strict(),
    },
    (args) =>
      guarded(async () =>
        withLauncher(
          requestResult.parse(
            await broker("request-cancel", { requestId: args.requestId }),
          ),
        ),
      ),
  );
  server.registerTool(
    "zerokey_wait_request",
    {
      description:
        "等待原申请状态变化，最多30秒；超时返回当前状态。用此工具取代反复查询，取消/失败后停止。",
      annotations: readOnly,
      inputSchema: z
        .object({
          requestId,
          afterStatus: z.enum(["pending", "authorizing"]).default("pending"),
          timeoutSeconds: z.number().int().min(1).max(30).default(25),
        })
        .strict(),
    },
    (args) =>
      guarded(async () =>
        withLauncher(requestResult.parse(await broker("request-wait", args))),
      ),
  );
  server.registerTool(
    "zerokey_project_setup",
    {
      description:
        "为已授权项目生成无密钥的 Chat Completions/Responses 接入模板与验证命令。只返回文件内容，不改项目；验证由 Agent 终端运行。",
      annotations: readOnly,
      inputSchema: z
        .object({ projectPath, model: z.string().max(300).optional() })
        .strict(),
    },
    (args) =>
      guarded(async () => projectSetup(broker, args.projectPath, args.model)),
  );
  return server;
}
