// Operator-only source administration. Never call this from a project Agent Skill.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name: string, fallback: string) =>
  args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback;
const configDir = option("--config-dir", join(homedir(), "Downloads", "config"));
const gateway = option("--gateway", "http://127.0.0.1:4000").replace(/\/$/, "");
const selected = option("--source", "all");
const envPath = join(root, ".env");
let envText = readFileSync(envPath, "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1).trim()];
    }),
);
const sources = [
  {
    id: "bbai",
    base: "https://api.sharesai.xyz/v1",
    catalog: "https://api.sharesai.xyz/v1/models",
    env: "BBAI_API_KEY",
    file: "bbai_key.key",
  },
  {
    id: "opencode-go",
    base: "",
    catalog: "https://opencode.ai/inference/go/v1/models",
    env: "OPENCODE_API_KEY",
    file: "oc_key.key",
  },
  {
    id: "openlux",
    base: "https://api.openlux.ai/v1",
    catalog: "https://api.openlux.ai/v1/models",
    env: "OPENLUX_API_KEY",
    file: "openlux_key.key",
  },
];
if (args.includes("--include-payg") || selected === "opencode-payg") {
  sources.push({
    id: "opencode-payg",
    base: "https://opencode.ai/inference/openai/v1",
    catalog: "https://opencode.ai/inference/v1/models",
    env: "OPENCODE_API_KEY",
    file: "oc_key.key",
  });
}
type CatalogModel = { id: string; api?: Record<string, unknown> };
async function request(
  url: string,
  key: string,
  body?: unknown,
  method = "POST",
) {
  const response = await fetch(url, {
    redirect: "error",
    method: body ? method : "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "x-litellm-session-id": `ses_zerokey_sync_${Date.now()}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(
      `Request failed (HTTP ${response.status}, ${new URL(url).host}${new URL(url).pathname}).`,
    );
  return response.json();
}
// /models also contains media jobs. Only recognizable text families are imported;
// discovery is not evidence that a model can complete a real request.
function textModel(id: string) {
  if (
    /image|imagen|dall-e|sora|veo|video|kling|wan-|seedance|music|suno|udio|tts|whisper|audio|speech|embedding|rerank|recraft|flux|stable-diffusion|midjourney/i.test(
      id,
    )
  )
    return false;
  return /^(gpt-|chatgpt-|o[134](?:-|$)|claude-|gemini-|deepseek-|qwen|glm-|kimi-|llama|mistral|magistral|codestral|gemma|grok-|doubao-|step-)/i.test(
    id,
  );
}
async function main() {
  const chosen = sources.filter(
    (source) => selected === "all" || source.id === selected,
  );
  if (!chosen.length) throw new Error("Unknown source.");
  if (args.includes("--import-credentials")) {
    for (const source of chosen) {
      const key = readFileSync(join(configDir, source.file), "utf8").trim();
      if (!key || /[\r\n]/.test(key))
        throw new Error(`Invalid credential file for ${source.id}.`);
      const line = `${source.env}=${key}`;
      const pattern = new RegExp(`^${source.env}=.*$`, "m");
      envText = pattern.test(envText)
        ? envText.replace(pattern, () => line)
        : `${envText.trimEnd()}\n${line}\n`;
      env[source.env] = key;
    }
    writeFileSync(envPath, envText);
    console.log(
      "Source credentials saved locally. Recreate the gateway container to load them.",
    );
    if (args.includes("--credentials-only")) return;
  }
  const master = env.LITELLM_MASTER_KEY;
  if (!master) throw new Error("Gateway credential is missing.");
  const existing = await request(`${gateway}/model/info`, master);
  const names = new Set(
    existing.data.map((row: { model_name: string }) => row.model_name),
  );
  for (const source of chosen) {
    const key = env[source.env];
    if (!key) throw new Error(`Missing local credential for ${source.id}.`);
    const catalog = await request(source.catalog, key);
    const models: CatalogModel[] = catalog.data;
    let added = 0,
      skipped = 0,
      excluded = 0;
    for (const model of models) {
      if (!model.id || (source.id === "openlux" && !textModel(model.id))) {
        excluded++;
        continue;
      }
      const name = `${source.id}/${model.id}`;
      if (names.has(name)) {
        skipped++;
        continue;
      }
      const apis = Object.keys(model.api ?? {});
      const family = source.id.startsWith("opencode-")
        ? apis.includes("responses")
          ? "responses"
          : apis.includes("messages")
            ? "messages"
            : apis.includes("generate-content")
              ? "generate-content"
              : "chat-completions"
        : "chat-completions";
      const provider =
        source.id === "opencode-go"
          ? "opencode_go"
          : source.id === "opencode-payg" && family === "messages"
            ? "anthropic"
            : source.id === "opencode-payg" && family === "generate-content"
              ? "gemini"
              : "openai";
      const base =
        source.id === "opencode-payg" && family === "messages"
          ? "https://opencode.ai/inference/anthropic/v1"
          : source.id === "opencode-payg" && family === "generate-content"
            ? "https://opencode.ai/inference/google/v1beta"
            : source.base;
      await request(`${gateway}/model/new`, master, {
        model_name: name,
        litellm_params: {
          model: `${provider}/${model.id}`,
          api_key: `os.environ/${source.env}`,
          ...(base ? { api_base: base } : {}),
        },
        model_info: {
          id: `${source.id}:${model.id}`,
          source: source.id,
          source_model: model.id,
          api_family: family,
          source_models_url: source.catalog,
          validation: "catalog-only",
        },
      });
      names.add(name);
      added++;
    }
    console.log(
      JSON.stringify({
        source: source.id,
        discovered: models.length,
        added,
        existing: skipped,
        excludedMediaOrUnknown: excluded,
      }),
    );
  }
  if (args.includes("--test")) {
    const model = option("--test", "openlux/gpt-4o-mini-2024-07-18");
    if (!names.has(model)) throw new Error("The test model is not registered.");
    const grant = await request(`${gateway}/key/generate`, master, {
      models: [model],
      max_budget: 0.1,
      duration: "10m",
      key_alias: "zerokey-source-verification",
    });
    try {
      const response = await request(
        `${gateway}/v1/chat/completions`,
        grant.key,
        {
          model,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_tokens: 32,
        },
      );
      const text = response.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim())
        throw new Error("The model did not return text.");
      console.log(
        JSON.stringify({
          model,
          text,
          tokens: response.usage?.total_tokens ?? null,
        }),
      );
    } finally {
      await request(`${gateway}/key/delete`, master, { keys: [grant.key] });
    }
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Source administration failed.",
  );
  process.exitCode = 1;
});
