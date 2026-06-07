<div align="center">

<img src="docs/banner.png" alt="Pi-Fox banner" width="100%">

# pi-fox

> A fox doesn't knock on the door. It finds the gap in the fence, slips through, and comes back with exactly what you sent it for. Pi-Fox is that instinct for your agent — quiet, quick, and it always brings receipts.

[![npm version](https://badge.fury.io/js/pi-fox.svg)](https://badge.fury.io/js/pi-fox)
[![npm downloads](https://img.shields.io/npm/dw/pi-fox)](https://www.npmjs.com/package/pi-fox)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/L2J320X82M)

</div>

---

Pi-Fox gives your pi agent a full [Playwright](https://playwright.dev/) browser (Firefox by default, Chromium and WebKit supported) — no API key required. Navigate pages, click, type, screenshot, and extract clean readable text out of the box. When you want web search too, drop in a key for any of four providers — Brave, Tavily, Exa, or Gemini — all with free tiers.

Every move is photographed and saved to your local filesystem as an audit trail you can open any time. Run headless by default; flip it visible when you want to watch it work. Change any setting by asking your agent or editing a single JSON file.

Under the hood it's a single TypeScript extension: a `ProviderImpl` registry for search backends, `withSupervisedScreenshot` wrapping every browser action, and `fetchJson` for all API calls — no curl, no shell-outs.

## Supervised mode

Screenshots are saved to `~/Pictures/pi-fox/sessions/<timestamp>/` after every navigation, click, and interaction — a chronological record of everything your agent did in the browser. Supervised mode is **on by default**.

Once you trust the workflow, turn it off by setting `"supervised": false` in your `settings.json`, or just ask your agent: *"turn off supervised mode."*

## Install

**Via npm (recommended):**
```bash
pi install npm:pi-fox
```

**Manual:**
```bash
git clone https://github.com/vaniteav/pi-fox
cp -r pi-fox ~/.pi/agent/extensions/
```

## Setup

```bash
pi -e ~/.pi/agent/extensions/pi-fox/index.ts -p "Set up web search"
```

Then walk through the `/browser` wizard — it guides you through choosing a search provider and storing your API key.

## Search providers

| Provider | Free tier | Notes |
|---|---|---|
| Brave Search | 2,000 queries/mo | [Get API key](https://api.search.brave.com/) |
| Tavily | 1,000 queries/mo | [Get API key](https://tavily.com/) |
| Exa | 2,500 queries/mo | [Get API key](https://exa.ai/) |
| Gemini | Free tier | [Get API key](https://aistudio.google.com/app/apikey) |

All providers have free tiers — you only need one. The first key you configure becomes the active provider automatically.

## Tools

### Browser (15 tools)

| Tool | Description |
|---|---|
| `browser_navigate` | Navigate the browser to a URL. |
| `browser_click` | Click an element identified by CSS selector, visible text, or ARIA role. |
| `browser_type` | Type text into an input, textarea, or contenteditable element. |
| `browser_snapshot` | Get the accessibility tree of the current page — structure, roles, and states. |
| `browser_screenshot` | Take a screenshot of the current page, returned as a base64 PNG or JPEG. |
| `browser_evaluate` | Run arbitrary JavaScript in the current page context and return the result. |
| `browser_wait` | Wait for an element to appear or disappear, or pause for a fixed timeout. |
| `browser_new_tab` | Open a new browser tab. |
| `browser_list_tabs` | List all open tabs with their index, URL, and title. |
| `browser_close_tab` | Close the current tab. |
| `browser_select_tab` | Switch focus to a tab by its index. |
| `browser_back` | Navigate back one step in the browser history. |
| `browser_forward` | Navigate forward one step in the browser history. |
| `browser_reload` | Reload the current page. |
| `browser_close` | Close the entire browser session and free resources. |

### Web (4 tools)

| Tool | Description |
|---|---|
| `web_search` | Search the web via your configured provider (Brave, Tavily, Exa, or Gemini); supports multi-query, recency filtering, and domain filtering. |
| `code_search` | Search for code examples, API docs, and Stack Overflow answers; uses Exa when available, falls back to `web_search`. |
| `fetch_content` | Fetch one or more URLs and extract clean readable text from the HTML. |
| `get_search_content` | Retrieve the full cached content from a previous search or fetch call by response ID or URL. |

## Commands

- `/browser` — Setup wizard + provider management: shows current config, detects configured keys, and lets you add, switch, or remove providers.
- `/web-switch` — Switch the active search provider at runtime without restarting.

## Configuration

Example `~/.pi/agent/settings.json` block:

```json
{
  "browserExt": {
    "supervised": true,
    "headless": true,
    "suppressStartupMessage": false,
    "BRAVE_API_KEY": "...",
    "activeProvider": "brave"
  }
}
```

All settings can also be changed by asking your agent — for example: *"switch to Exa for searches"* or *"run the browser in visible mode."*

## Credits

- Browser automation powered by [Playwright](https://playwright.dev/) (Microsoft)
- Built for [pi coding agent](https://github.com/earendil-works/pi-coding-agent) by earendil-works

## License

MIT
