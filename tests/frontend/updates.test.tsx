import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { UpdateSettings } from "../../src/features/settings/update-settings";
import type { UpdateStatus } from "../../src/types";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  check: vi.fn(),
  install: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@/api", () => ({
  desktop: true,
  api: {
    updateStatus: mocks.status,
    checkUpdate: mocks.check,
    installUpdate: mocks.install,
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
const latest: UpdateStatus = {
  currentVersion: "0.2.0",
  status: "latest",
  version: null,
  notes: null,
  checkedAt: "2026-11-17T10:00:00Z",
  downloaded: 0,
  total: null,
  error: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue(latest);
  mocks.check.mockResolvedValue(latest);
  mocks.listen.mockResolvedValue(vi.fn());
});
it("checks again after a network failure and only offers installation for an available version", async () => {
  render(<UpdateSettings />);
  expect(await screen.findByText("已是最新版本")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "下载并重启更新" })).toBeNull();
  mocks.check.mockResolvedValueOnce({
    ...latest,
    status: "error",
    error: "无法连接 GitHub 更新服务，请检查网络后重试。",
  });
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  expect(await screen.findByText(/无法连接 GitHub/)).not.toBeNull();
  mocks.check.mockResolvedValueOnce({
    ...latest,
    status: "available",
    version: "0.3.0",
    notes: "新增更新内容",
  });
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  expect(
    (
      (await screen.findByRole("button", {
        name: "下载并重启更新",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(screen.queryByText(/无法连接 GitHub/)).toBeNull();
});
it("reports download progress and disables duplicate update operations", async () => {
  render(<UpdateSettings />);
  await screen.findByText("已是最新版本");
  const callback = mocks.listen.mock.calls[0][1];
  const { act } = await import("@testing-library/react");
  await act(() =>
    callback({
      payload: {
        ...latest,
        status: "downloading",
        version: "0.3.0",
        downloaded: 5242880,
        total: 10485760,
      },
    }),
  );
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "50",
  );
  expect(
    (screen.getByRole("button", { name: "正在下载" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "检查更新" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("preserves the available update and shows an installation failure for retry", async () => {
  mocks.status.mockResolvedValueOnce({
    ...latest,
    status: "available",
    version: "0.3.0",
  });
  mocks.install.mockRejectedValueOnce(
    new Error("正在完成本机授权，请完成后重新安装更新。"),
  );
  render(<UpdateSettings />);
  fireEvent.click(
    await screen.findByRole("button", { name: "下载并重启更新" }),
  );
  await waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/正在完成本机授权/)).not.toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: "下载并重启更新",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
