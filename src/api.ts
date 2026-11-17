import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  AgentRequest,
  GrantRequest,
  Project,
  Snapshot,
  TestResult,
  AgentIntegration,
  UpdateStatus,
} from "./types";

export const desktop = isTauri();

export async function getSnapshot(): Promise<Snapshot> {
  if (!desktop) {
    return {
      gateway: "http://127.0.0.1:4000",
      connected: false,
      message:
        "当前是浏览器界面预览。请打开桌面应用，连接真实网关和系统凭据库。",
      platform: "browser",
      credentialStore: "桌面应用中可用",
      nativeAuth: false,
      pinConfigured: false,
      models: [],
      projects: [],
    };
  }
  return invoke("snapshot");
}

export const api = {
  updateStatus: () => invoke<UpdateStatus>("update_status"),
  checkUpdate: () => invoke<UpdateStatus>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
  grant: (request: GrantRequest) =>
    invoke<Project>("create_grant", { request }),
  revoke: (id: string) => invoke<void>("revoke_grant", { id }),
  test: (id: string) => invoke<TestResult>("test_grant", { id }),
  connect: (gateway: string, master: string) =>
    invoke<void>("connect_gateway", { gateway, master }),
  setPin: (pin: string, previous: string | null) =>
    invoke<void>("set_app_pin", { pin, previous }),
  dashboard: () => invoke<void>("open_dashboard"),
  pending: () => invoke<AgentRequest | null>("pending_request"),
  cancel: (id: string) => invoke<void>("cancel_request", { id }),
  requestStatus: (id: string) =>
    invoke<{ status: string; message?: string | null }>("request_status", {
      id,
    }),
  dismissApproval: () => invoke<void>("dismiss_approval"),
  integration: (client: string, install = false) =>
    invoke<AgentIntegration>("agent_integration", { client, install }),
};
