# Ridgeline 1.12.0 (vendored)

The design system the panel UI is built on, copied here so this repository is
self-contained. Do not edit these files: page-specific CSS goes in the panel's
own stylesheet. A new Ridgeline release goes in a new `ridgeline/<version>/`
directory (t6-paneld serves everything under `ridgeline/` as immutable).

| File | What |
| --- | --- |
| `tokens.css` | colours (light and dark), type, spacing, radius, shadow, motion; the `@font-face` rules. Load it first. |
| `bundle.css` | every component, reading only the variables from `tokens.css` |
| `fonts/` | EB Garamond, Source Sans 3, 汇文明朝体 GBK (GB2312 subset) |
| `icons/light`, `icons/regular` | the Phosphor icons in use; `icons.json` lists them |
| `Dashboard/device-up6.png` | the UP6 line drawing for 总览 › 本机, a CSS mask that `bundle.css` loads |

## Licences and credits

- **Phosphor Icons** — MIT, © Phosphor Icons. See `icons/LICENSE.txt`.
- **EB Garamond** — SIL Open Font License 1.1, © The EB Garamond Project Authors. See `fonts/EBGaramond-OFL.txt`.
- **Source Sans 3** — SIL Open Font License 1.1, © Adobe, Reserved Font Name "Source". See `fonts/SourceSans3-OFL.txt`.
- **汇文明朝体 GBK (Huiwen-MinchoGBK)** — CC0 1.0 Universal; please do not sell the font on its own. Thanks to its authors. See `fonts/HuiwenMinchoGBK-CC0.txt`.

The panel's 关于 page lists the same credits under 开源许可.
