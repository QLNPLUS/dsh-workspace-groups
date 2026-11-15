# Third-party notices

## Tabler Icons

`client/client.js` embeds the outline **path data** of 20 Tabler icons (the
group glyph picker and the group row marker). The package itself is not
installed or bundled — only the SVG path strings are inlined, so the plugin
keeps working with no runtime dependency.

- Source: https://github.com/tabler/tabler-icons
- Package: `@tabler/icons` (path data read from `tabler-nodes-outline.json` of
  v3.52.0)
- License: MIT — Copyright (c) 2020-2026 Paweł Kuna

```
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Icon set used: folder, star, heart, flag, bookmark, bolt, flame, rocket, bug,
code, terminal, book, bulb, briefcase, home, flask, palette, music, world, lock.

## Why the icon picker looks like a file manager's

The Edit Group dialog (name + icon + colour in one sheet) follows the pattern
of NarraFork's `RecentTabFolderEditModal` (MPL-2.0) — a Mantine `Modal` with a
`SimpleGrid` of icon buttons and a row of `ColorSwatch`es. Only the *layout
idea* is borrowed; no code, no Mantine dependency, and the icons come from
Tabler directly rather than from that project. NarraFork itself is not a
dependency of this plugin.

## Theme tokens

Every colour except the 10 accent presets is read from the DSH theme
(`--dsw-alias-*`), so light/dark and future theme changes are the platform's
business, not this plugin's. The accent hex pairs are listed in
`client/client.js` (`PALETTE`) and documented in `docs/DETAIL.md`.
