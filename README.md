# Pi Browser + Web Access Extension

**Author:** Pi Agent OWL on behalf of Vanitea

A unified pi extension combining browser automation (via Playwright) and web access tools (search, content fetching, code search) in a single package.

## Features

### Browser Automation (15 tools)

Powered by Playwright. Default browser is Firefox, configurable to Chromium or WebKit.

| Tool | Description |
|---|---|
| `browser_navigate` | Navigate to a URL |
| `browser_click` | Click an element (CSS selector, text, role) |
| `browser_type` | Type text into an input/textarea/contenteditable |
| `browser_snapshot` | Get the accessibility tree (page structure, roles, states) |
| `browser_screenshot` | Take a screenshot (PNG/JPEG, returned as base64 image) |
| `browser_evaluate` | Run JavaScript in the page context |
| `browser_wait` | Wait for an element to appear/disappear or for a timeout |
| `browser_tab_list` | List all open tabs (index, URL, title) |
| `browser_tab_new` | Open a new tab |
| `browser_tab_close` | Close the current tab |
| `browser_tab_select` | Switch to a tab by index |
| `browser_back` | Navigate back in history |
| `browser_forward` | Navigate forward in history |
| `browser_reload` | Reload the current page |
| `browser_close` | Close the entire browser session |

### Web Access (4 tools)

| Tool | Description |
|---|---|
| `web_search` | AI-powered web search via Brave, Tavily, Exa, Gemini, or Perplexity. Returns synthesized answers/citations when the selected provider supports them. Supports multi-query, recency filtering, and domain filtering. |
| `code_search` | Search for code examples, API docs, Stack Overflow answers. Uses Exa when available, falls back to web_search. |
| `fetch_content` | Fetch and extract readable text content from one or more URLs. |
| `get_search_content` | Retrieve full cached content from a previous web_search, code_search, or fetch_content call by responseId or URL. |

### Commands

| Command | Description |
|---|---|
| `/browser` | Show browser engine, headless mode, session status, search provider, and config variables. |

## Requirements

- Node.js (bundled with pi)
- Playwright browsers (auto-installed on first use)
- At least one search API key for web_search / code_search (see Configuration)

## Installation

Run the interactive setup wizard (recommended first step):

```
/browser
```

It will detect if you have search keys configured and guide you through setup.
You can skip and configure later — browser automation tools work without a key.

### Quick Start (single extension file)

```bash
pi -e ~/.pi/agent/extensions/pi-browser/index.ts
```

### Auto-load on every pi session

Place the extension in pi's auto-discovered extensions directory:

```
~/.pi/agent/extensions/pi-browser/index.ts
```

Pi will auto-discover and load it on startup. Verify with the `/browser` command.

### Project-local install

```
.pi/extensions/pi-browser/index.ts
```

## Browser Setup

Playwright browsers are downloaded automatically. If needed, install manually:

```bash
# Install all supported browsers
cd ~/.pi/agent/extensions/pi-browser
npx playwright install firefox chromium webkit

# Or install just Firefox (default)
npx playwright install firefox
```

## Configuration

### Interactive Setup (Recommended)

Run `/browser` — the onboarding wizard will:
1. Detect configured providers
2. Offer to set one up (with signup links and setup instructions)
3. Let you switch active provider, add more, or remove

### Provider Keys

All providers have free tiers. You only need one.

| Provider | Env Variable | Free Tier | Signup | Best For |
|---|---|---|---|---|
| **Brave Search** ★ | `BRAVE_API_KEY` | 2,000 queries/mo | https://brave.com/search/api/ | Best free option |
| Tavily | `TAVILY_API_KEY` | 1,000 queries/mo | https://app.tavily.com/ | AI agent–optimized results |
| Exa | `EXA_API_KEY` | 2,500 queries/mo | https://exa.ai/ | Code search |
| Google Gemini | `GEMINI_API_KEY` | free tier | https://aistudio.google.com/app/apikey | Synthesized answers |
| Perplexity AI | `PERPLEXITY_API_KEY` | — (paid) | https://www.perplexity.ai/settings/api | Synthesized answers |

★ = recommended free option. First configured key becomes active automatically.

### Key Storage (choose one — any method works)

**Method 1: Environment variable (simplest)**
```bash
# Current session only
export BRAVE_API_KEY="your-key-here"

# Persistent — add to shell profile
echo 'export BRAVE_API_KEY="your-key-here"' >> ~/.bashrc

# Windows persistent (Git Bash / cmd)
setx BRAVE_API_KEY "your-key-here"
```

**Method 2: pi settings.json (persistent, version-controllable)**
Edit `~/.pi/agent/settings.json`:
```json
{
  "browserExt": {
    "BRAVE_API_KEY": "your-key-here",
    "activeProvider": "brave"
  }
}
```

**Method 3: Cloud / CI (gh secrets, Railway, Render, Fly)**
Set the env var in your platform's dashboard. The extension reads it automatically at runtime.

**Priority:** `settings.json` > environment variable. Use settings.json when you want the key explicitly tracked; use env vars for cloud deployments or temporary keys.

### Switching Providers at Runtime

Use `/web-switch` to change the active provider without restarting:

```
/web-switch
```

Or `/browser` → "Switch active provider".

The switch writes to `settings.json` and takes effect after `/reload`.

### Browser Settings

| Environment Variable | Default | Description |
|---|---|---|
| `PI_BROWSER_ENGINE` | `firefox` | Browser engine: `firefox`, `chromium`, `webkit` |
| `PI_BROWSER_HEADLESS` | `true` | Run browser headlessly. Set to `false` for visible browser |
| `PI_BROWSER_WIDTH` | `1280` | Viewport width in pixels |
| `PI_BROWSER_HEIGHT` | `720` | Viewport height in pixels |

## Usage Examples

### Basic Browser Navigation

```
Navigate to https://example.com and tell me the title
```

```
Take a screenshot of the page
```

```
Click the "Learn more" link and tell me the new URL
```

### Form Interaction

```
Navigate to https://httpbin.org/forms/post, fill in the "custname" field with "test", then submit the form
```

### Research Workflow

```
Search for "latest Rust async runtime benchmarks 2026" and fetch the top 3 results
```

```
Search for "React vs Vue performance" with queries: ["React vs Vue benchmarks 2026", "React vs Vue developer experience"]
```

```
Search GitHub for "python fastAPI authentication middleware code examples"
```

### Multi-tab workflow

```
Open a new tab and navigate to https://iana.org, then list all tabs
```

## Architecture

```
pi-browser/
├── index.ts          — Extension entry point (all tools and commands)
├── package.json      — Dependencies and pi package manifest
├── package-lock.json — Lock file
├── node_modules/     — Playwright + web scraping libraries
└── README.md         — This file
```

### Dependencies

| Package | Purpose |
|---|---|
| `playwright` | Browser automation (Firefox/Chromium/WebKit) |
| `@mozilla/readability` | Article/content extraction from HTML |
| `linkedom` | Lightweight DOM parser |
| `p-limit` | Concurrency limiter for parallel fetches |
| `turndown` | HTML to Markdown conversion |

### Tool Flow

```
web_search / code_search
  → detect provider from settings.json or env vars
  → call API (Brave/Tavily/Exa/Gemini/Perplexity)
  → cache results to ~/.pi/web-cache/
  → return answer + citations/results

fetch_content
  → curl the URL(s)
  → extract readable text from HTML (strip scripts, styles, and tags)
  → cache to ~/.pi/web-cache/
  → return extracted text

Current limitation: PDF and YouTube/video extraction are not implemented yet.

get_search_content
  → look up cache by responseId or URL
  → return full stored content
```

```
browser_navigate → getPage() → Playwright Browser → Page
browser_click    → getPage() → page.click(selector)
browser_screenshot → getPage() → page.screenshot() → base64 image
browser_snapshot → getPage() → page.locator("body").ariaSnapshot()
```

### Browser Session Lifecycle

- `session_start` — Notifies that the extension is loaded (engine, headless mode, search provider)
- First `browser_navigate` — Lazily opens a browser instance (persists across tool calls)
- `session_shutdown` — Closes the browser and cleans up

The browser session persists across multiple tool calls within a conversation turn, so you can navigate, click, type, and snapshot in sequence.

## Security Notes

- Browser runs in headless mode by default. Set `PI_BROWSER_HEADLESS=false` for visible browser.
- `ignoreHTTPSErrors` is enabled for browser contexts (for testing against self-signed certs).
- Search API keys are read from `~/.pi/agent/settings.json` or environment variables, never hardcoded in source.
- Cached content is stored in `~/.pi/web-cache/` as plain JSON files.

## Troubleshooting

### Browser won't start

```bash
# Reinstall Playwright browsers
cd ~/.pi/agent/extensions/pi-browser
npx playwright install firefox
```

### Tool conflicts

If you have `pi-web-access` installed as a pi package, remove it — pi will refuse to load both:

```bash
pi remove npm:pi-web-access
```

### Search returns "No search provider configured"

Run `/browser` for the interactive setup wizard. It will guide you through:
1. Choosing a provider (Brave = free, 2,000 queries/mo)
2. Getting a key
3. Setting it up via your preferred method

Or set a key manually:
```bash
export BRAVE_API_KEY="your-key-here"
```

### Extension not auto-loading

Verify the file is in the right place:

```bash
ls ~/.pi/agent/extensions/pi-browser/index.ts
```

Then reload pi or run `/reload` in interactive mode.

### Switching providers

Use `/web-switch` to change the active provider, or `/browser` → "Switch active provider".

## License

MIT
