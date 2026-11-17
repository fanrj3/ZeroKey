// Run before styles load so the first frame uses the saved local preference.
(() => {
  let theme = "dark";
  try {
    const saved = localStorage.getItem("zerokey-theme");
    if (["dark", "light", "system"].includes(saved)) theme = saved;
  } catch {
    // The default remains usable when local storage is unavailable.
  }
  const resolved =
    theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  root.dataset.themePreference = theme;
})();
