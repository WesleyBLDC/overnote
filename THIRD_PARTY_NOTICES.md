# Third party notices

Overnote itself is MIT licensed (see [`LICENSE`](LICENSE)).
This file lists third party material that ships inside Overnote under its own licence.
npm dependencies carry their licences in their own packages and are not repeated here.

## Geist and Geist Mono

The editor bundles the Geist and Geist Mono variable fonts, upright and italic, as WOFF2 files in [`editor/src/fonts/`](editor/src/fonts/).

- Copyright (c) 2023 Vercel, in collaboration with basement.studio.
- Licence: SIL Open Font License, Version 1.1. The full text is in [`editor/src/fonts/OFL.txt`](editor/src/fonts/OFL.txt), and the editor build writes it next to the fonts as `assets/Geist-OFL.txt`.
- Source: the `geist` npm package, version 1.9.2 (repository `github.com/vercel/geist-font`), files `dist/fonts/geist-sans/Geist-Variable.woff2`, `dist/fonts/geist-sans/Geist-Italic[wght].woff2`, `dist/fonts/geist-mono/GeistMono-Variable.woff2`, and `dist/fonts/geist-mono/GeistMono-Italic[wght].woff2`.
- Changes: none to the font data; the two italic files are renamed to `Geist-Italic-Variable.woff2` and `GeistMono-Italic-Variable.woff2`.

SHA-256 of the bundled files:

| File | SHA-256 |
|---|---|
| `Geist-Variable.woff2` | `3626eba547294501c8a4d662c7d9ea3b49734409a4c5a1ccf12fa86429b1687e` |
| `Geist-Italic-Variable.woff2` | `01115bfdb15e9aacfe1c950d81544061e0b0d2a5228755ec0b9e9ba3ab2c36a9` |
| `GeistMono-Variable.woff2` | `5d93ee62680bbec1abc5405c2658311f9396f6f9a821ef8551ec463887e600d4` |
| `GeistMono-Italic-Variable.woff2` | `3e047933a05511ebb32a655219efa40363fd9aacaff209fab3e13866b6ff605f` |

To update them, take the same four files from a newer `geist` release, keep the names above, refresh `OFL.txt` from the package's `LICENSE.txt`, and update the version and hashes here.
