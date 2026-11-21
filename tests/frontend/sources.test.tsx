import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceSync } from "../../src/features/sources/source-sync";
import { ThemeProvider } from "../../src/components/theme-provider";
import App from "../../src/App";
import type { SourceStatus } from "../../src/types";
import { deferred, snapshot } from "./fixtures";

const mocks = vi.hoisted(() => ({
  sources: vi.fn(),
  checkSource: vi.fn(),
  applySource: vi.fn(),
  sourceAutoAdd: vi.fn(),
  getSnapshot: vi.fn(),
}));
vi.mock("@/api", () => ({
  desktop: true,
  api: mocks,
  getSnapshot: mocks.getSnapshot,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: () => Promise.resolve(() => {}) }),
}));
vi.mock("@/components/window-controls", () => ({ WindowControls: () => null }));

const models = [
  { id: "bbai/old", source: "bbai", protocol: "chat-completions" },
];
const source: SourceStatus = {
  id: "bbai",
  registered: 1,
  supported: true,
  autoAdd: false,
  checkedAt: null,
  syncedAt: null,
  pending: [],
  missing: [],
  lastAdded: [],
  error: null,
  history: [],
};
const preview: SourceStatus = {
  ...source,
  checkedAt: "2026-11-21T00:00:00Z",
  pending: [
    { id: "bbai/gpt-6.2-sol", protocol: "chat-completions" },
    { id: "bbai/gpt-6.2-astra", protocol: "chat-completions" },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.sources.mockResolvedValue([source]);
  mocks.checkSource.mockResolvedValue(preview);
  mocks.sourceAutoAdd.mockResolvedValue({ ...source, autoAdd: true });
  mocks.getSnapshot.mockResolvedValue({ ...snapshot, models });
});
function show() {
  const onSynced = vi.fn(async () => {});
  render(
    <ThemeProvider>
      <SourceSync models={models} connected onSynced={onSynced} />
    </ThemeProvider>,
  );
  return { onSynced };
}

describe("source model synchronization", () => {
  it("previews before writing, adds only selected models and retains unselected candidates", async () => {
    const user = userEvent.setup();
    const { onSynced } = show();
    await user.click(
      await screen.findByRole("button", { name: "同步 BBAI 模型" }),
    );
    const sheet = screen.getByRole("dialog", { name: "同步预览 · BBAI" });
    expect(mocks.applySource).not.toHaveBeenCalled();
    await user.click(
      within(sheet).getByRole("checkbox", { name: "添加 bbai/gpt-6.2-astra" }),
    );
    mocks.applySource.mockResolvedValue({
      ...preview,
      registered: 2,
      pending: [preview.pending[1]],
      lastAdded: [preview.pending[0].id],
    });
    await user.click(
      within(sheet).getByRole("button", { name: "确认添加 1 个模型" }),
    );
    expect(mocks.applySource).toHaveBeenCalledWith("bbai", [
      "bbai/gpt-6.2-sol",
    ]);
    await waitFor(() => expect(onSynced).toHaveBeenCalledOnce());
    expect(
      within(sheet)
        .getByRole("checkbox", { name: "添加 bbai/gpt-6.2-astra" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(within(sheet).getByText("已添加 1 个模型")).toBeTruthy();
  });
  it("preserves selection on errors and prevents dismissal or repeat submission during writes", async () => {
    const user = userEvent.setup();
    show();
    await user.click(
      await screen.findByRole("button", { name: "同步 BBAI 模型" }),
    );
    const later = deferred<SourceStatus>();
    mocks.applySource.mockReturnValueOnce(later.promise);
    await user.click(screen.getByRole("button", { name: "确认添加 2 个模型" }));
    await user.keyboard("{Escape}");
    expect(
      (screen.getByRole("button", { name: "关闭" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "确认添加 2 个模型",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(() => later.reject(new Error("来源正在同步，请稍后重试。")));
    expect(await screen.findByText("来源正在同步，请稍后重试。")).toBeTruthy();
    expect(
      screen
        .getByRole("checkbox", { name: "添加 bbai/gpt-6.2-sol" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(mocks.applySource).toHaveBeenCalledOnce();
  });
  it("keeps automatic additions off until enabled and persists the returned state", async () => {
    const user = userEvent.setup();
    show();
    const checkbox = await screen.findByRole("checkbox", {
      name: "自动添加 BBAI 新模型",
    });
    await waitFor(() =>
      expect((checkbox as HTMLButtonElement).disabled).toBe(false),
    );
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(mocks.sourceAutoAdd).not.toHaveBeenCalled();
    await user.click(checkbox);
    expect(mocks.sourceAutoAdd).toHaveBeenCalledWith("bbai", true);
    await waitFor(() =>
      expect(checkbox.getAttribute("aria-checked")).toBe("true"),
    );
    expect(mocks.applySource).not.toHaveBeenCalled();
  });
  it("reports missing upstream models and partial additions without hiding the remaining scope", async () => {
    const user = userEvent.setup();
    show();
    mocks.checkSource.mockResolvedValue({ ...preview, missing: ["bbai/old"] });
    await user.click(
      await screen.findByRole("button", { name: "同步 BBAI 模型" }),
    );
    expect(screen.getAllByText("1 个型号不可获取").length).toBeGreaterThan(0);
    expect(screen.queryByText(/待检查/)).toBeNull();
    mocks.applySource.mockResolvedValue({
      ...preview,
      registered: 2,
      pending: [preview.pending[1]],
      lastAdded: [preview.pending[0].id],
      error: "部分型号未能添加；本次已添加 1 个，请检查来源配置后重试。",
    });
    await user.click(screen.getByRole("button", { name: "确认添加 2 个模型" }));
    await screen.findByRole("alert", { name: "同步需要处理" });
    expect(
      screen
        .getByRole("checkbox", { name: "添加 bbai/gpt-6.2-astra" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
  it("keeps source synchronization available when every model is unavailable", async () => {
    const user = userEvent.setup();
    mocks.sources.mockResolvedValue([
      { ...source, checkedAt: preview.checkedAt, missing: ["bbai/old"] },
    ]);
    render(
      <ThemeProvider>
        <SourceSync models={[]} connected onSynced={vi.fn(async () => {})} />
      </ThemeProvider>,
    );
    const sync = await screen.findByRole("button", { name: "同步 BBAI 模型" });
    expect((sync as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("1 个型号不可获取")).toBeTruthy();
    await user.click(sync);
    expect(
      screen.getByRole("dialog", { name: "同步预览 · BBAI" }),
    ).toBeTruthy();
  });
  it("makes synchronized models available in project authorization after refresh", async () => {
    const user = userEvent.setup();
    mocks.applySource.mockResolvedValue({
      ...preview,
      registered: 3,
      pending: [],
      lastAdded: preview.pending.map((model) => model.id),
    });
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    await screen.findByText("网关已连接");
    await user.click(screen.getByRole("button", { name: "模型来源" }));
    await user.click(
      await screen.findByRole("button", { name: "同步 BBAI 模型" }),
    );
    mocks.getSnapshot.mockResolvedValue({
      ...snapshot,
      models: [
        ...models,
        ...preview.pending.map((model) => ({ ...model, source: "bbai" })),
      ],
    });
    await user.click(screen.getByRole("button", { name: "确认添加 2 个模型" }));
    await screen.findByText("已添加 2 个模型");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("button", { name: "项目授权" }));
    await user.click(screen.getByRole("button", { name: "添加项目" }));
    expect(screen.getByRole("checkbox", { name: "gpt-6.2-sol" })).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "gpt-6.2-astra" }),
    ).toBeTruthy();
  });
});
