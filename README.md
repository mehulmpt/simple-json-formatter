# Simple JSON Formatter

A lightweight Chrome extension that automatically formats JSON documents with syntax highlighting, collapsible nodes, and per-field copy.

## Features

- **Auto-detection** — formats any `application/json`, `text/json`, or `text/plain` page that contains valid JSON
- **Syntax highlighting** — color-coded keys, strings, numbers, booleans, and nulls
- **Collapsible nodes** — click the arrow to collapse/expand objects and arrays
- **Per-field copy** — hover any line and click the copy icon to grab that value
- **Clickable URLs** — string values that are URLs become clickable links
- **Light & dark mode** — follows your system theme automatically
- **Raw mode** — append `#raw` to any URL to bypass formatting
- **Zero permissions** — no background scripts, no storage, no network access

## Install

**[Install from Chrome Web Store](https://chromewebstore.google.com/detail/glpiippmmmcehcakihlcckekenppambg)**

Or build from source:

1. Clone this repo
2. Install dependencies and build:
   ```sh
   pnpm install
   pnpm run build
   ```
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (top right)
5. Click **Load unpacked** and select the `out/` folder

## Development

```sh
pnpm run dev          # watch mode — rebuilds on save
pnpm run build        # production build → out/
pnpm run lint         # eslint
pnpm run typecheck    # tsc --noEmit
pnpm run format       # prettier --write
```

## Project Structure

```
src/
├── content.ts        # detection, rendering, event handling
├── styles.css        # light/dark theme via CSS custom properties
├── manifest.json     # Chrome extension manifest (MV3)
└── css.d.ts          # TS declaration for CSS imports
out/                  # build output — load this in Chrome
```

## License

MIT — [Mehul Mohan](https://github.com/mehulmpt)
