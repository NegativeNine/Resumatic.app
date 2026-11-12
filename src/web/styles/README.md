# Styles

The web app's styles, loaded in this order by `src/web/App.tsx`.

Source: the design system Resumatic, version 1794444170-a305 (copied 12 Nov 2026).

| File | What it holds | Source |
| --- | --- | --- |
| `tokens.css` | Custom properties: colours for light and dark, each block opening with its `color-scheme`, then spacing, radius, layout and the two font stacks | The design system's `tokens.css`, custom properties only |
| `fonts.css` | Atkinson Hyperlegible Next, latin and latin-ext | Written for the app; the files are in `../fonts` |
| `type.css` | The type ramp: `display`, `title-1` to `title-4`, `lede`, `body`, `body-sm`, `label`, `caption`, `quote-lg`, `quote`, `quote-sm` and the sheet's `paper-*` classes | The design system's `tokens.css`, type classes only |
| `components.css` | The rs- component styles | The design system's `components/bundle.css`, without its `body` rule |
| `controls.css` | The design system's buttons, fields and messages for the app's v1 elements and class names, at zero specificity | Written for the app, from the rs- rules |
| `app.css` | The page's base elements, its layout, and the glue between the app's pages and the rs- components. Loaded last. The v1 rules that pages still use live here too, written with the tokens, and the shared app- layout classes, the equivalents of the redesign's rd- classes, appended at the end. After them, one marked block per redesign stage (`/* stage 2: the shell */` to `/* stage 7: outside */`): a stage adds shared rules only inside its own block, and a room's own rules go in `rooms/<room>.css` (Account's too, in `rooms/account.css`); the raw-colour test reads them. | Written for the app |

The design system is the source of truth for every copied file. To change a token or a component style, change it in the design system first, then copy it here, so the two never drift. The system's own `tokens.css` is not loaded whole: its type classes would collide with the app's `.quote` and `.lede`, and its `@font-face` has no latin-ext file.

Status classes have plain names: `rs-mark--backed`, `--needs-you`, `--note`, `--working` and `--problem` (with `--beta`, and the app's `--status` for a job's own tracking), and `rs-tick--backed`, `--needs-you`, `--left-out`, `--working`, `--problem` and `--todo`. `Badge` and `Tick` in `components/ui.tsx` take only these, and the maps beside them (`REVIEW_MARK`, `REVIEW_TICK`, `LINE_MARK`, `RUN_MARK`) translate stored states. The bundle still accepts the earlier names; the app no longer uses them.

`test/web/tokens.test.ts` holds the contrast of each pair in both themes, and fails if a stylesheet reads a custom property no copied file defines or if the app's own stylesheets use a raw colour.

The theme is set on `<html>` as `data-theme="light"` or `data-theme="dark"` by `public/theme.js`, before the first paint. `src/web/theme.ts` changes it while the app runs.
