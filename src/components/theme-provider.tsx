import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

export type Theme = "dark" | "light" | "system";
type ResolvedTheme = Exclude<Theme, "system">;
const storageKey = "zerokey-theme";
const systemQuery = "(prefers-color-scheme: dark)";
const isTheme = (value: unknown): value is Theme =>
  value === "dark" || value === "light" || value === "system";

const ThemeContext = createContext<{
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
} | null>(null);

function applyTheme(theme: Theme): ResolvedTheme {
  const resolved =
    theme === "system"
      ? window.matchMedia(systemQuery).matches
        ? "dark"
        : "light"
      : theme;
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  root.dataset.themePreference = theme;
  return resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setPreference] = useState<Theme>(() => {
    const initial = document.documentElement.dataset.themePreference;
    return isTheme(initial) ? initial : "dark";
  });
  const [resolvedTheme, setResolved] = useState<ResolvedTheme>(() =>
    document.documentElement.classList.contains("light") ? "light" : "dark",
  );

  useEffect(() => {
    const media = window.matchMedia(systemQuery);
    const syncSystem = () => setResolved(applyTheme(theme));
    const syncStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) return;
      if (event.key === storageKey || event.key === null) {
        const next = isTheme(event.newValue) ? event.newValue : "dark";
        setPreference(next);
        setResolved(applyTheme(next));
      }
    };
    syncSystem();
    media.addEventListener("change", syncSystem);
    window.addEventListener("storage", syncStorage);
    return () => {
      media.removeEventListener("change", syncSystem);
      window.removeEventListener("storage", syncStorage);
    };
  }, [theme]);

  function setTheme(next: Theme) {
    if (!isTheme(next)) return;
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // Theme switching still works for this session without local storage.
    }
    setPreference(next);
    setResolved(applyTheme(next));
  }

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme requires ThemeProvider");
  return context;
}
