import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGateway } from "../../src/hooks/use-gateway";
import { deferred, project, snapshot } from "./fixtures";
import type { Snapshot } from "../../src/types";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  onFocusChanged: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock("@/api", () => ({ desktop: true, getSnapshot: mocks.getSnapshot }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: mocks.onFocusChanged }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSnapshot.mockReset().mockResolvedValue(snapshot);
  mocks.onFocusChanged.mockReset().mockResolvedValue(mocks.unlisten);
});

describe("gateway snapshots", () => {
  it("keeps the last snapshot and check time on failure, then clears stale state on recovery", async () => {
    const { result } = renderHook(() => useGateway());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const checked = result.current.lastCheckedAt;
    expect(checked).toBeInstanceOf(Date);
    mocks.getSnapshot.mockRejectedValueOnce(new Error("offline"));
    await act(() => result.current.refresh());
    expect(result.current.snapshot).toBe(snapshot);
    expect(result.current.lastCheckedAt).toBe(checked);
    expect(result.current.error).toBe("offline");
    await act(() => result.current.refresh());
    expect(result.current.error).toBe("");
  });

  it("refreshes on foreground events once, skips hidden and grant-review windows, and cleans up", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const { result, rerender, unmount } = renderHook(
      ({ autoRefresh }) => useGateway({ autoRefresh }),
      { initialProps: { autoRefresh: true } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    const nativeFocus = mocks.onFocusChanged.mock.calls[0][0];
    now.mockReturnValue(20_000);
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    act(() => window.dispatchEvent(new Event("focus")));
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => {
      nativeFocus({ payload: true });
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(2);
    rerender({ autoRefresh: false });
    now.mockReturnValue(30_000);
    act(() => {
      nativeFocus({ payload: true });
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(2);
    rerender({ autoRefresh: true });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(3);
    unmount();
    await act(async () => {});
    expect(mocks.unlisten).toHaveBeenCalledTimes(2);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(3);
  });

  it("ignores an older request that finishes after a newer one", async () => {
    const older = deferred<Snapshot>();
    mocks.getSnapshot.mockReturnValueOnce(older.promise);
    const { result } = renderHook(() => useGateway());
    const latest = { ...snapshot, gateway: "https://new.example.test" };
    mocks.getSnapshot.mockResolvedValueOnce(latest);
    await act(() => result.current.refresh());
    await act(async () => older.resolve(snapshot));
    expect(result.current.snapshot).toBe(latest);
  });

  it("preserves a saved grant when an older snapshot arrives and the next refresh fails", async () => {
    const { result } = renderHook(() => useGateway());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const older = deferred<Snapshot>();
    mocks.getSnapshot.mockReturnValueOnce(older.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refresh();
    });
    act(() => result.current.rememberProject(project));
    await act(async () => {
      older.resolve(snapshot);
      await pending;
    });
    mocks.getSnapshot.mockRejectedValueOnce("offline");
    await act(() => result.current.refresh());
    expect(result.current.snapshot?.projects).toEqual([project]);
    expect(result.current.error).toBe("offline");
  });
});
