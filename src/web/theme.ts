/** What the person chose on Account. "system" follows the operating system's setting. */
export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/** The localStorage key, shared with public/theme.js, which applies the theme before first paint. */
export const THEME_KEY = "resumatic:theme";

/**
 * Whether a person with no stored choice follows the operating system. Keep in step with
 * FOLLOW_SYSTEM in public/theme.js.
 */
export const FOLLOW_SYSTEM = true;

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function getThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage can be blocked; treat it as no choice.
  }
  return "system";
}

export function systemTheme(): Theme {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(choice: ThemeChoice): Theme {
  if (choice !== "system") return choice;
  return FOLLOW_SYSTEM ? systemTheme() : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Stores the choice for this browser and applies it at once. */
export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage can be blocked; the theme still changes for this visit.
  }
  applyTheme(resolveTheme(choice));
}

/**
 * Keeps the page's theme in step with the operating system (while the choice is "system") and
 * with choices made in other tabs. Returns a function that stops listening.
 */
export function syncTheme(): () => void {
  const reapply = () => applyTheme(resolveTheme(getThemeChoice()));
  const query = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === THEME_KEY) reapply();
  };
  query?.addEventListener("change", reapply);
  window.addEventListener("storage", onStorage);
  return () => {
    query?.removeEventListener("change", reapply);
    window.removeEventListener("storage", onStorage);
  };
}
