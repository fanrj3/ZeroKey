import type { Project, Snapshot } from "../../src/types";

// Synthetic data only. No gateway, system credentials or local project files are used.
export const project: Project = {
  id: "test-project",
  name: "Demo",
  path: "C:\\test\\demo",
  models: ["test/text-model"],
  dailyBudget: 1,
  duration: null,
  expires: null,
  createdAt: "2026-11-17T00:00:00Z",
  keyHash: "synthetic-hash",
  status: "active",
  spend: 0,
};
export const snapshot: Snapshot = {
  gateway: "http://127.0.0.1:4000",
  connected: true,
  message: null,
  platform: "test",
  credentialStore: "测试凭据库",
  nativeAuth: true,
  pinConfigured: false,
  models: [
    { id: "test/text-model", source: "test", protocol: "chat-completions" },
  ],
  projects: [],
};
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
