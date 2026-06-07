# pi-web

> Browser automation + multi-provider web search for your Pi agent — with automatic screenshot audit trail (optional).

Give your Pi coding agent a real browser and live web access. Every page it navigates to, every click it makes, is photographed automatically and saved to your local filesystem — so you can open that folder any time and see exactly what your agent saw. You stay in control: supervised mode is on by default, headless is on by default, and every setting can be changed by asking your agent or editing a single JSON file.

## Supervised mode

Supervised mode is **on by default**. Every navigation, click, and interaction saves a screenshot to `~/Pictures/pi-web/sessions/<timestamp>/`. This is your audit trail — you can open that folder at any time and see a chronological record of everything your agent did in the browser.

Once you trust the workflow, turn it off by setting `"supervised": false` in your `settings.json`, or by asking your agent: *"turn off supervised mode."*

## Install

**Via npm (recommended):**
```bash
pi install npm:pi-web
```

**Manual:**
```bash
git clone https://github.com/vaniteav/pi-web
cp -r pi-web ~/.pi/agent/extensions/
```

## Setup

```bash
pi -e ~/.pi/agent/extensions/pi-web/index.ts -p "Set up web search"
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
