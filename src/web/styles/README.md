# Styles

The web app's styles, loaded in this order by `src/web/App.tsx`:

| File | What it holds | Source |
| --- | --- | --- |
| `tokens.css` | Custom properties: colors for light and dark, spacing, radius, layout, font stacks | The design system's `project/tokens.css`, custom properties only |
| `fonts.css` | `@font-face` rules for Schibsted Grotesk and Newsreader italic | Written for the app; the files are in `../fonts` |
| `components.css` | The rs- component styles | The design system's `project/components/bundle.css`, without its `body` rule |
| `../styles.css` | The v1 styles, rewritten to use the tokens. It shrinks with each redesign PR and then goes away. | v1 |
| `app.css` | Page layout, and the glue between the app's pages and the rs- components. Loaded last. | Written for the app |

The design system is the source of truth for every copied file. To change a token or a component style, change it in the design system first, then copy it here, so the two never drift.

The theme is set on `<html>` as `data-theme="light"` or `data-theme="dark"` by `public/theme.js`, before the first paint. `src/web/theme.ts` changes it while the app runs.
