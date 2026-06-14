# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-06-13

### Added
- Eight browser tools: `browser_scroll`, `browser_key`, `browser_hover`, `browser_drag`, `browser_upload_file`, `browser_console`, `browser_network`, `browser_dialog`
- Capture infrastructure (`CaptureState`) — console logs, network requests, and dialog handling collected automatically and surviving browser restarts
- `browser_click` accepts optional `x`/`y` to click by viewport position (no selector) — for strict-CSP and screenshot-driven flows

### Changed
- Custom search providers now require `browserExt.trustCustomProviders: true` to load — their transforms run arbitrary code, so they stay inert until trusted

### Removed
- Dead code: unused `Result<T>` and `findCacheByUrl()`

### Fixed
- `browser_back` observes same-document `pushState` (SPA) navigation (waits on `popstate`, not `load`)
- `browser_tab_close` runs the tab's unload lifecycle (`pagehide`) before switching
- `fetch_content` revalidates every redirect hop (see Security)
- Firefox/Playwright compatibility for `browser_hover`, `browser_scroll`, `browser_key`, `browser_type`

### Security
- `fetch_content` SSRF guard — `http`/`https` only; rejects loopback/private/link-local/cloud-metadata IPs on the resolved host and every redirect hop
- Custom-provider code (`new Function`) runs only with `browserExt.trustCustomProviders: true` (off by default)
- `browser_upload_file` honors `browserExt.allowedUploadRoots` when set — symlink-safe, so paths can't escape an allowed root

## [1.0.0] - 2026-06-07

Initial public release (`pi-fox`).

### Added
- Browser automation via Playwright (Firefox default): navigate, click, type, snapshot, screenshot, evaluate, wait, tab management, back/forward/reload/close
- Multi-provider web search (Brave, Perplexity, Tavily, Exa, Gemini) with automatic fallback, plus `code_search`, `fetch_content`, and `get_search_content`
- `/search` command hub — switch/add/remove providers and onboarding (replaces `/web-switch`); `/search <id>` for instant switching
- `/browser` command — engine settings (headless, supervised-mode screenshots)
- Custom search provider wizard — add any search API via `/search` without editing source; single `async function(query, n, apiKey, fetchJson)` transform contract with a live raw→mapped test and an editable draft template
- `fetch_content` HTML→Markdown via [Turndown](https://github.com/mixmark-io/turndown), with a plain-text fallback
- Optional supervised mode — auto-screenshot after each browser action

[Unreleased]: https://github.com/vaniteav/pi-fox/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/vaniteav/pi-fox/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/vaniteav/pi-fox/releases/tag/v1.0.0
