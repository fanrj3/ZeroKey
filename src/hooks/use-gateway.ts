import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop, getSnapshot } from "@/api";
import type { Project, Snapshot } from "@/types";
import { errorText } from "@/lib/format";

export function useGateway({ autoRefresh = true } = {}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const sequence = useRef(0);
  const refreshing = useRef(false);
  const lastAttemptAt = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++sequence.current;
    refreshing.current = true;
    lastAttemptAt.current = Date.now();
    setLoading(true);
    try {
      const next = await getSnapshot();
      if (id === sequence.current) {
        setSnapshot(next);
        setLastCheckedAt(new Date());
        setError("");
      }
    } catch (error) {
      if (id === sequence.current) setError(errorText(error));
    } finally {
      if (id === sequence.current) {
        refreshing.current = false;
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current++;
      refreshing.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!autoRefresh) return;
    let disposed = false;
    function checkForeground() {
      if (
        disposed ||
        document.visibilityState === "hidden" ||
        refreshing.current ||
        Date.now() - lastAttemptAt.current < 5000
      )
        return;
      void refresh();
    }
    window.addEventListener("focus", checkForeground);
    document.addEventListener("visibilitychange", checkForeground);
    const nativeListener = desktop
      ? getCurrentWindow()
          .onFocusChanged(({ payload }) => {
            if (payload) checkForeground();
          })
          .catch(() => null)
      : null;
    return () => {
      disposed = true;
      window.removeEventListener("focus", checkForeground);
      document.removeEventListener("visibilitychange", checkForeground);
      void nativeListener?.then((unlisten) => unlisten?.());
    };
  }, [autoRefresh, refresh]);
  const rememberProject = useCallback((project: Project) => {
    // An older snapshot must not overwrite the grant just saved locally.
    sequence.current++;
    refreshing.current = false;
    setLoading(false);
    setSnapshot(
      (current) =>
        current && {
          ...current,
          projects: [
            project,
            ...current.projects.filter(({ id }) => id !== project.id),
          ],
        },
    );
  }, []);
  return { snapshot, loading, error, lastCheckedAt, refresh, rememberProject };
}
