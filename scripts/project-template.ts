import { scriptPath, runtimeBinary } from "./broker-client.ts";
import type { BrokerCall } from "./broker-client.ts";

export const clientTemplate = `// Credentials are injected by ZeroKey. Never log the environment or request headers.
export async function generateText(prompt) {
  const { OPENAI_BASE_URL: base, OPENAI_API_KEY: key, OPENAI_MODEL: model, LLM_API_PROTOCOL: protocol, LITELLM_SESSION_ID: session } = process.env;
  if (!base || !key || !model) throw new Error("请通过 ZeroKey 启动器运行。");
  const responses = protocol === "responses";
  if (!responses && !["chat", "chat-completions"].includes(protocol)) throw new Error("此模板支持 Chat Completions 和 Responses；请检查模型协议。");
  let response;
  try {
    response = await fetch(base + (responses ? "/responses" : "/chat/completions"), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key, "x-litellm-session-id": session },
      body: JSON.stringify(responses ? { model, input: prompt, max_output_tokens: 64 } : { model, messages: [{ role: "user", content: prompt }], max_tokens: 64 }),
      signal: AbortSignal.timeout(45000)
    });
  } catch { throw new Error("网关连接失败或超时，请在 ZeroKey 检查连接。"); }
  if (!response.ok) throw new Error("模型请求失败（HTTP " + response.status + "），请检查授权、预算和来源额度。");
  let data;
  try { data = await response.json(); } catch { throw new Error("网关没有返回有效 JSON。"); }
  const text = responses ? (data.output_text ?? data.output?.flatMap(item => item.content ?? []).filter(part => part.type === "output_text").map(part => part.text).join("")) : data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("模型没有返回文字，请检查协议。");
  return text.trim();
}
`;
export const verifyTemplate = `import { generateText } from "./client.mjs";
try { console.log(await generateText("Reply with exactly: ZeroKey OK")); }
catch (error) { console.error(error.message); process.exitCode = 1; }
`;

export async function projectSetup(
  broker: BrokerCall,
  path: string,
  selected?: string,
) {
  const status = (await broker("status", { path })) as any;
  if (status.status !== "active" || !status.credentialPresent)
    throw new Error("PROJECT_NOT_READY");
  const catalog = (await broker("models")) as any;
  const model = catalog.models.find(
    (m: any) =>
      status.project.models.includes(m.id) &&
      (!selected || m.id === selected) &&
      ["responses", "chat", "chat-completions"].includes(m.protocol),
  );
  if (!model) throw new Error("TEMPLATE_PROTOCOL_UNSUPPORTED");
  return {
    projectPath: status.project.path as string,
    model: model.id as string,
    protocol: model.protocol as string,
    files: [
      { path: ".zerokey/client.mjs", content: clientTemplate },
      { path: ".zerokey/verify.mjs", content: verifyTemplate },
    ],
    verify: {
      command: runtimeBinary(),
      args: [
        scriptPath("zerokey"),
        "run",
        "--project",
        status.project.path,
        "--model",
        model.id,
        "--",
        process.execPath,
        ".zerokey/verify.mjs",
      ],
    },
    instruction:
      "先将模板保存到项目（不覆盖已有文件），再运行 verify。验证会产生一次短文本用量；通过后在项目中导入 generateText。凭证只由启动器注入，不打印环境。",
  };
}
