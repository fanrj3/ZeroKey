import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { ThemeProvider } from "../../src/components/theme-provider";
import { GrantSheet } from "../../src/features/projects/grant-sheet";
import { ApprovalForm } from "../../src/features/projects/approval-window";
import { deferred, project, snapshot } from "./fixtures";
import type { Snapshot } from "../../src/types";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  grant: vi.fn(),
  pending: vi.fn(),
  requestStatus: vi.fn(),
  dismissApproval: vi.fn(),
  integration: vi.fn(),
}));
vi.mock("@/api", () => ({
  desktop: true,
  getSnapshot: mocks.getSnapshot,
  api: {
    grant: mocks.grant,
    pending: mocks.pending,
    requestStatus: mocks.requestStatus,
    dismissApproval: mocks.dismissApproval,
    integration: mocks.integration,
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: () => Promise.resolve(() => {}) }),
}));
vi.mock("@/components/window-controls", () => ({ WindowControls: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSnapshot.mockReset().mockResolvedValue(snapshot);
  mocks.grant.mockReset();
  mocks.pending.mockResolvedValue(null);
  mocks.requestStatus.mockResolvedValue({ status: "pending" });
  mocks.dismissApproval.mockResolvedValue(undefined);
  mocks.integration.mockResolvedValue({
    client: "codex",
    configured: false,
    connected: false,
    toolsAvailable: false,
    path: "C:/synthetic/config.toml",
    snippet: "",
    error: null,
  });
});

describe("authorization handoff", () => {
  it("keeps an Agent scope visible while allowing model edits on demand", async () => {
    const user = userEvent.setup();
    render(
      <GrantSheet
        snapshot={{
          ...snapshot,
          models: [
            ...snapshot.models,
            {
              id: "test/other-model",
              source: "test",
              protocol: "chat-completions",
            },
          ],
        }}
        request={{
          requestId: "3f8f79b4-0a8e-4aaa-8be0-e0011f930cc1",
          requestedAt: Date.now() / 1000,
          name: project.name,
          path: project.path,
          models: project.models,
          dailyBudget: 1,
          duration: null,
          pin: null,
        }}
        onClose={async () => {}}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText("test/text-model")).toBeTruthy();
    expect(
      (screen.getByLabelText("项目文件夹") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("checkbox")).toBeNull();
    const adjust = screen.getByRole("button", { name: "调整模型" });
    await user.click(adjust);
    await user.click(screen.getByRole("checkbox", { name: "other-model" }));
    await user.click(adjust);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("test/other-model")).toBeTruthy();
    await user.click(adjust);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "other-model",
        }) as HTMLInputElement
      ).getAttribute("aria-checked"),
    ).toBe("true");
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("dismisses an Agent review when its MCP request is canceled externally", async () => {
    mocks.pending
      .mockResolvedValueOnce({
        requestId: "3f8f79b4-0a8e-4aaa-8be0-e0011f930cc1",
        requestedAt: Date.now() / 1000,
        name: "Agent demo",
        path: project.path,
        models: project.models,
        dailyBudget: 1,
        duration: null,
        pin: null,
      })
      .mockResolvedValue(null);
    mocks.requestStatus.mockResolvedValue({ status: "canceled" });
    render(
      <ApprovalForm
        snapshot={snapshot}
        request={{
          requestId: "3f8f79b4-0a8e-4aaa-8be0-e0011f930cc1",
          requestedAt: Date.now() / 1000,
          name: "Agent demo",
          path: project.path,
          models: project.models,
          dailyBudget: 1,
          duration: null,
          pin: null,
        }}
      />,
    );
    await waitFor(() => expect(mocks.dismissApproval).toHaveBeenCalled(), {
      timeout: 5000,
    });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("opens selectors without submitting and preserves the edited budget after native verification fails", async () => {
    const user = userEvent.setup();
    mocks.grant.mockRejectedValue(new Error("本机验证已取消"));
    render(
      <ApprovalForm
        snapshot={snapshot}
        request={{
          requestId: "3f8f79b4-0a8e-4aaa-8be0-e0011f930cc1",
          requestedAt: Date.now() / 1000,
          name: "Agent demo",
          path: project.path,
          models: project.models,
          dailyBudget: 1,
          duration: null,
          pin: null,
        }}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "模型 ID" }));
    expect(mocks.grant).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await user.clear(screen.getByLabelText("每日预算（美元）"));
    await user.type(screen.getByLabelText("每日预算（美元）"), "0.5");
    await user.click(screen.getByRole("button", { name: "确认并授权" }));
    await screen.findByText("本机验证已取消");
    expect(mocks.grant).toHaveBeenCalledWith(
      expect.objectContaining({ dailyBudget: 0.5, models: project.models }),
    );
    expect(
      (screen.getByLabelText("每日预算（美元）") as HTMLInputElement).value,
    ).toBe("0.5");
    expect(
      (screen.getByRole("button", { name: "确认并授权" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(mocks.dismissApproval).not.toHaveBeenCalled();
  });
  it("brings each failed submission into view and focus while keeping project inputs", async () => {
    const user = userEvent.setup();
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const onSaved = vi.fn();
    mocks.grant.mockRejectedValue(new Error("测试：授权验证未通过"));
    render(
      <GrantSheet
        snapshot={snapshot}
        project={project}
        onClose={async () => {}}
        onSaved={onSaved}
      />,
    );
    await user.click(screen.getByRole("button", { name: "确认并授权" }));
    const error = await screen.findByRole("alert", { name: "请检查后重试" });
    expect(document.activeElement).toBe(error);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect((screen.getByLabelText("项目名称") as HTMLInputElement).value).toBe(
      "Demo",
    );
    expect(
      (screen.getByLabelText("项目文件夹") as HTMLInputElement).value,
    ).toBe(project.path);
    expect(onSaved).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认并授权" }));
    expect(document.activeElement).toBe(
      await screen.findByRole("alert", { name: "请检查后重试" }),
    );
    expect(mocks.grant).toHaveBeenCalledTimes(2);
    expect(scroll).toHaveBeenCalledTimes(2);
  });
  it.each(["failed", "provisioned"])(
    "keeps %s diagnostics visible until acknowledged",
    async (status) => {
      const user = userEvent.setup();
      mocks.grant.mockRejectedValue(
        new Error("签发或清理未完成，请检查项目状态"),
      );
      mocks.requestStatus.mockResolvedValue({
        status,
        message: "签发或清理未完成，请检查项目状态",
      });
      render(
        <ApprovalForm
          snapshot={snapshot}
          request={{
            requestId: "3f8f79b4-0a8e-4aaa-8be0-e0011f930cc1",
            requestedAt: Date.now() / 1000,
            name: "Agent demo",
            path: project.path,
            models: project.models,
            dailyBudget: 1,
            duration: null,
            pin: null,
          }}
        />,
      );
      await user.click(screen.getByRole("button", { name: "确认并授权" }));
      const error = await screen.findByRole("alert", { name: "授权需要处理" });
      expect(document.activeElement).toBe(error);
      expect(
        (
          screen.getByRole("button", {
            name: "确认并授权",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(mocks.dismissApproval).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole("button", { name: "关闭" }),
      );
      expect(mocks.dismissApproval).toHaveBeenCalledOnce();
    },
  );

  it("opens the saved project's Agent instructions even when refresh fails", async () => {
    const user = userEvent.setup();
    mocks.getSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValue(new Error("测试：刷新失败"));
    mocks.grant.mockResolvedValue(project);
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "添加项目" }));
    await user.type(screen.getByLabelText("项目文件夹"), project.path);
    await user.type(screen.getByLabelText("项目名称"), project.name);
    await user.click(screen.getByRole("checkbox", { name: "text-model" }));
    await user.click(screen.getByRole("button", { name: "确认并授权" }));
    const detail = await screen.findByRole("dialog", { name: "Demo" });
    expect(within(detail).getByText("在 Agent 中使用")).toBeTruthy();
    expect(
      within(detail).getByText(
        "$provision-key 使用 Demo 的现有授权运行当前任务",
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(within(detail).getByText("网关状态待检查")).toBeTruthy(),
    );
    expect(
      within(detail).queryByRole("button", { name: "确认并授权" }),
    ).toBeNull();
    expect(mocks.grant).toHaveBeenCalledTimes(1);
  });

  it("does not label a stale successful connection as connected after a failed refresh", async () => {
    const user = userEvent.setup();
    const later = deferred<Snapshot>();
    mocks.getSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockReturnValueOnce(later.promise);
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    await screen.findByText("网关已连接");
    await user.click(screen.getByRole("button", { name: "刷新网关状态" }));
    await act(async () => later.reject(new Error("测试：网关不可达")));
    expect(screen.queryByText("网关已连接")).toBeNull();
    expect(screen.getByText("状态待检查")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "添加项目" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/当前保留上次读取的数据/)).toBeTruthy();
  });

  it("focuses the local authorization section from the credentials entry", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    await screen.findByText("网关已连接");
    await user.click(screen.getByRole("button", { name: "系统凭据库" }));
    expect(document.activeElement?.id).toBe("local-authorization");
    // Also works when the user is already on Settings.
    fireEvent.click(screen.getByRole("button", { name: "系统凭据库" }));
    expect(document.activeElement?.id).toBe("local-authorization");
  });
});
