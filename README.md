<div align="center">

<img src="https://raw.githubusercontent.com/vaniteav/pi-fox/main/docs/banner.png" alt="pi-fox banner" width="100%">

# pi-fox

> A fox doesn't knock on the door. It finds the gap in the fence, slips through, and comes back with exactly what you sent it for. pi-fox is that instinct for your agent — quiet, quick, and it always brings receipts.

[![npm version](https://badge.fury.io/js/pi-fox.svg)](https://badge.fury.io/js/pi-fox)
[![npm downloads](https://img.shields.io/npm/dw/pi-fox)](https://www.npmjs.com/package/pi-fox)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/L2J320X82M)

</div>

---

pi-fox gives your pi agent a full [Playwright](https://playwright.dev/) browser (Firefox by default; Chromium and WebKit selectable) — no API key required. Navigate pages, click, type, screenshot, and extract clean, readable Markdown out of the box. For better agentic web search, drop in a key for any of five providers — Brave, Tavily, Exa, and Gemini all have free tiers, plus Perplexity (paid). Prefer a different one? Use the setup wizard to add it.

With supervised mode, every move is captured and saved to your local filesystem as a chronological audit trail. Run headless by default; flip it visible when you want to watch it work. Change any setting by asking your agent or editing a single JSON file.

Under the hood it's a single TypeScript extension: a `ProviderImpl` registry for search backends, `withSupervisedScreenshot` wrapping every browser action, and `fetchJson` for all API calls — no curl, no shell-outs.

## Highlights

- **No API key to start** — a full Playwright browser works out of the box. Add a search key only when you want web search.
- **Five search providers, four free** — Brave, Tavily, Exa, and Gemini all have free tiers (Perplexity is paid). Switch at runtime with `/search`, or add your own via the wizard.
- **Built-in audit trail** — supervised mode screenshots every action to your local disk in order, so you can see exactly what your agent did. On by default; flip it off once you trust the flow.
- **Clean text, not raw HTML** — `fetch_content` extracts readable Markdown from any page.
- **27 tools** — 23 browser + 4 web, all in one extension.

## Setup

**1. Install the extension**

```bash
pi install npm:pi-fox
npx playwright install firefox   # one-time: downloads the browser pi-fox drives
```

That's all browser automation needs — navigate, click, screenshot, and text extraction work immediately, no API key. *(Manual install: `git clone https://github.com/vaniteav/pi-fox && cp -r pi-fox ~/.pi/agent/extensions/ && npx playwright install firefox`.)*

**2. Add a search provider — optional**

For agentic web search, load pi and run `/search` — the wizard walks you through picking a provider and storing your key. Or just ask your agent: *"set up Brave search."* Skip it entirely if you only need browser control.

## Search providers

| Provider | Free tier | Notes |
|---|---|---|
| Brave Search | 2,000 queries/mo | [Get API key](https://api.search.brave.com/) |
| Tavily | 1,000 queries/mo | [Get API key](https://tavily.com/) |
| Exa | 2,500 queries/mo | [Get API key](https://exa.ai/) |
| Gemini | Free tier | [Get API key](https://aistudio.google.com/app/apikey) |
| Perplexity | Paid (no free tier) | [Get API key](https://www.perplexity.ai/settings/api) |

You only need one. The first key you configure becomes the active provider automatically. With multiple providers configured, use `/search <provider-id>` to switch instantly at runtime (e.g. `/search brave`).

Need a provider that isn't listed? The `/search` wizard can add any search API. Because a custom provider runs its own transform code, it stays disabled until you set `trustCustomProviders: true` (see [Configuration](#configuration)).

## Tools

### Browser (23 tools)

| Tool | Description |
|---|---|
| `browser_navigate` | Navigate to a URL. |
| `browser_click` | Click an element by CSS selector, visible text, or ARIA role — or by `x`/`y` viewport coordinates (no selector) for strict-CSP and screenshot-driven flows. |
| `browser_type` | Type into an input, textarea, or contenteditable element. |
| `browser_key` | Press a key or combination — Enter, Tab, Escape, arrows, and shortcuts like `Control+A`. |
| `browser_hover` | Move the cursor over an element to trigger hover effects, tooltips, or menus. |
| `browser_drag` | Drag an element and drop it onto another. |
| `browser_scroll` | Scroll the page or a specific element (wheel, scroll-into-view, or by offset). |
| `browser_upload_file` | Set local file(s) on a file input. Honors the `allowedUploadRoots` allowlist when configured. |
| `browser_snapshot` | Get the accessibility tree of the current page — structure, roles, and states. |
| `browser_screenshot` | Take a screenshot, returned as a base64 PNG or JPEG. |
| `browser_evaluate` | Run arbitrary JavaScript in the page context and return the result. |
| `browser_wait` | Wait for an element to appear or disappear, or pause for a fixed timeout. |
| `browser_console` | Read captured browser console logs (collected automatically as the browser runs). |
| `browser_network` | Read captured network requests (collected automatically as the browser runs). |
| `browser_dialog` | Arm a handler for the next dialog (alert/confirm/prompt) — call before the triggering action. |
| `browser_tab_list` | List all open tabs with their index, URL, and title. |
| `browser_tab_new` | Open a new browser tab. |
| `browser_tab_close` | Close the current tab. |
| `browser_tab_select` | Switch focus to a tab by its index. |
| `browser_back` | Navigate back one step in history — handles same-document SPA (`pushState`) navigations. |
| `browser_forward` | Navigate forward one step in browser history. |
| `browser_reload` | Reload the current page. |
| `browser_close` | Close the entire browser session and free resources. |

### Web (4 tools)

| Tool | Description |
|---|---|
| `web_search` | Search the web via your configured provider; supports multi-query, recency filtering, and domain filtering. |
| `code_search` | Search for code examples, API docs, and Stack Overflow answers; uses Exa when available, falls back to `web_search`. |
| `fetch_content` | Fetch one or more URLs and extract clean, readable Markdown from the HTML. |
| `get_search_content` | Retrieve cached content from a previous search or fetch by response ID or URL. |

## Commands

- `/browser` — Browser status and settings: engine, headless mode, supervised mode.
- `/search` — Search provider management: status, switch, add, remove, and onboarding wizard. Use `/search <provider-id>` to switch instantly at runtime (e.g. `/search brave`).

## Supervised mode

Screenshots are saved to `~/Pictures/pi-fox/sessions/<timestamp>/` after every navigation, click, and interaction — a chronological record of everything your agent did in the browser. Supervised mode is **on by default**.

Once you trust the workflow, turn it off:

```json
{ "browserExt": { "supervised": false } }
```

Or just ask your agent: *"turn off supervised mode."*

## Configuration

Full example block in `~/.pi/agent/settings.json`:

```json
{
  "browserExt": {
    "supervised": true,
    "headless": true,
    "suppressStartupMessage": false,
    "activeProvider": "brave",
    "trustCustomProviders": false,
    "allowedUploadRoots": ["/absolute/path/you/allow"],
    "BRAVE_API_KEY": "...",
    "TAVILY_API_KEY": "...",
    "EXA_API_KEY": "...",
    "GEMINI_API_KEY": "..."
  }
}
```

You only need the key(s) for providers you want to use. All settings can also be changed by asking your agent — for example: *"switch to Exa for searches"* or *"run the browser in visible mode."*

- `trustCustomProviders` — custom search providers (added via the `/search` wizard) run their own transform code, so they stay **disabled until you explicitly set this to `true`**.
- `allowedUploadRoots` — optional allowlist of directories `browser_upload_file` may read from; paths outside them (and symlinks escaping them) are rejected. Omit for no restriction.

Engine and browser defaults can also be set via environment variables (useful for CI): `PI_BROWSER_ENGINE` (`firefox` | `chromium` | `webkit`), `PI_BROWSER_HEADLESS`, `PI_BROWSER_SUPERVISED`, `PI_BROWSER_WIDTH`, and `PI_BROWSER_HEIGHT`.

## Credits

- Browser automation powered by [Playwright](https://playwright.dev/) (Microsoft)
- Built for [pi](https://github.com/earendil-works/pi) by earendil-works

## License

MIT
