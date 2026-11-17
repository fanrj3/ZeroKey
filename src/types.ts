export interface Model {
  id: string;
  source: string;
  protocol: string;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  models: string[];
  dailyBudget: number;
  duration: string | null;
  expires: string | null;
  createdAt: string;
  keyHash: string;
  status: string;
  spend: number;
}
export interface Snapshot {
  gateway: string;
  connected: boolean;
  message: string | null;
  platform: string;
  credentialStore: string;
  nativeAuth: boolean;
  pinConfigured: boolean;
  models: Model[];
  projects: Project[];
}
export interface GrantRequest {
  name: string;
  path: string;
  models: string[];
  dailyBudget: number;
  duration: string | null;
  pin: string | null;
  requestId?: string;
  reasons?: string[];
}
export interface AgentRequest extends GrantRequest {
  requestId: string;
  requestedAt: number;
}
export interface TestResult {
  text: string;
  model: string;
  tokens: number | null;
}
export type Page = "projects" | "sources" | "usage" | "settings";

export interface UpdateStatus {
  currentVersion: string;
  status:
    | "idle"
    | "checking"
    | "latest"
    | "available"
    | "downloading"
    | "installing"
    | "error";
  version: string | null;
  notes: string | null;
  checkedAt: string | null;
  downloaded: number;
  total: number | null;
  error: string | null;
}

export interface AgentIntegration {
  client: string;
  path: string;
  configured: boolean;
  conflict: boolean;
  connected: boolean;
  toolsAvailable: boolean;
  backup: string | null;
  error: string | null;
  snippet: string;
}

export const sourceNames: Record<string, string> = {
  bbai: "BBAI",
  "opencode-go": "OpenCode Go",
  "opencode-payg": "OpenCode 余额付费",
  openlux: "Openlux",
  gateway: "网关配置",
};

export function sourceName(source: string): string {
  return sourceNames[source] ?? source;
}
export function modelLabel(id: string): string {
  return id.split("/").slice(1).join("/") || id;
}
export function modelCapability(protocol: string): string {
  if (
    [
      "chat",
      "chat-completions",
      "responses",
      "messages",
      "generate-content",
    ].includes(protocol)
  )
    return "文字接口";
  if (["images", "image", "image_generation"].includes(protocol))
    return "图片接口";
  if (["audio", "speech", "transcription", "transcriptions"].includes(protocol))
    return "音频接口";
  if (["video", "videos"].includes(protocol)) return "视频接口";
  if (["embedding", "embeddings"].includes(protocol)) return "向量接口";
  return "能力待确认";
}
export function durationLabel(duration: string | null): string {
  if (!duration || duration === "unlimited") return "长期有效";
  const match = /^(\d+)([dh])$/.exec(duration);
  return match
    ? `${match[1]} ${match[2] === "d" ? "天" : "小时"}`
    : "期限待确认";
}
export function expiryLabel(expires: string | null): string {
  if (!expires) return "长期有效";
  const date = new Date(expires);
  return Number.isNaN(date.valueOf())
    ? "到期时间未知"
    : `${date.toLocaleDateString("zh-CN")} 到期`;
}
