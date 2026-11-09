import { describe, expect, it } from "vitest";
import themeScript from "../../public/theme.js?raw";
import { FOLLOW_SYSTEM, getThemeChoice, resolveTheme, setThemeChoice, THEME_KEY } from "../../src/web/theme";

/** Runs public/theme.js as the browser does, before the app loads. */
function runThemeScript(): string | undefined {
  new Function(themeScript)();
  return document.documentElement.dataset.theme;
}

describe("public/theme.js", () => {
  it("applies a stored choice before the first paint", () => {
    window.localStorage.setItem(THEME_KEY, "dark");
    expect(runThemeScript()).toBe("dark");
  });

  it("falls back to light for no choice or a value it doesn’t know", () => {
    expect(runThemeScript()).toBe("light");
    window.localStorage.setItem(THEME_KEY, "sepia");
    expect(runThemeScript()).toBe("light");
  });

  it("agrees with theme.ts on whether to follow the operating system", () => {
    expect(themeScript).toContain(`var FOLLOW_SYSTEM = ${FOLLOW_SYSTEM};`);
  });
});

describe("theme.ts", () => {
  it("stores a choice and applies it at once", () => {
    setThemeChoice("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(getThemeChoice()).toBe("dark");
  });

  it("forgets the choice for system", () => {
    setThemeChoice("dark");
    setThemeChoice("system");
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    expect(getThemeChoice()).toBe("system");
    expect(document.documentElement.dataset.theme).toBe(resolveTheme("system"));
  });

  it("keeps an explicit choice whatever the system prefers", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });
});
