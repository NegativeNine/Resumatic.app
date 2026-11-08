// Sets the theme on <html> before the first paint, so the page never flashes the wrong colors.
// It runs as a separate file because the Content-Security-Policy allows no inline scripts.
// src/web/theme.ts stores the choice and keeps this logic in step while the app runs.
(function () {
  // Off until the Appearance setting ships: then a person with no stored choice follows the OS.
  var FOLLOW_SYSTEM = false;
  var choice = null;
  try {
    choice = window.localStorage.getItem("resumatic:theme");
  } catch (e) {
    // Storage can be blocked. Fall back to the default theme.
  }
  var theme = "light";
  if (choice === "light" || choice === "dark") {
    theme = choice;
  } else if (FOLLOW_SYSTEM && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    theme = "dark";
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
