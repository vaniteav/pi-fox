# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.6] - 2026-06-28

### Fixed
- `browser_forward` now mirrors the `browser_back` SPA guard: arms a `popstate` marker and uses `waitUntil: "commit"` so same-document (`pushState`) forward entries no longer time out with a false failure.
- `browser_tab_new` no longer leaks the newly created page on navigation failure; the tab is closed before the error is re-thrown.
- `web_search` with `includeContent: true` now returns `contentFetchId` in its result details, making the background-fetched page bodies retrievable via `get_search_content`.
- `urlToCacheKey` now appends a DJB2 hash of the full URL so two URLs sharing the same first characters no longer collide in the fetch cache.
- `browser_network` clear now also clears `pendingNetworkQueue`; previously pending entries accumulated across repeated clears.
- `browser_key` `count` is now clamped to `[1, 100]` before the press loop; previously negative or very large values caused silent no-ops or indefinite hangs.

## [1.0.5] - 2026-06-28

### Changed
- Updated development dependencies to pi SDK v0.80.2; no runtime changes for extension consumers.
- Removed three unused runtime dependencies (`@mozilla/readability`, `linkedom`, `p-limit`); content extraction has always used Turndown directly.

### Fixed
- `ImageContent` shape updated to the flat `{ data, mimeType }` format introduced in SDK v0.80.2 (was using the old Anthropic API `source: { type, mediaType, data }` wrapper).
- Explicit return-type annotation added to `execute()` functions with multiple `details` shapes, resolving `AgentToolResult<T>` inference failures under TypeScript 6.0.
- Dead second parameter removed from the internal `toolError` helper and its 11 call sites.
- CHANGELOG compare links for versions 1.0.3 and 1.0.4 were missing; `[Unreleased]` still pointed at v1.0.2. All links now correct.

## [1.0.4] - 2026-06-21

### Fixed
- Provider menus in `/search` and `/browser` (switch / add / remove / custom-provider wizard) passed `{ value, label }` option objects to the pi SDK's `ui.select`, which renders and returns plain strings — so menus showed `[object Object]` and a selection returned an object instead of an id, corrupting config (e.g. `activeProvider`). Menus now pass string labels and map the choice back to its value; rows are label-only.

## [1.0.3] - 2026-06-18

### Changed
- Align tool failure behavior with pi SDK v0.79.7: extension tools now throw for failed executions instead of returning `isError: true`, so pi marks failures as actual tool errors.
- `browser_dialog` now uses pi's Google-compatible `StringEnum` helper for its `accept`/`dismiss` action schema.

### Fixed
- Declared the `@earendil-works/pi-ai` peer dependency used by the `StringEnum` schema helper.

## [1.0.2] - 2026-06-14

Documentation release — version bump so npm serves the updated README. No runtime changes.

### Fixed
- Install docs: the npm path now includes `npx playwright install firefox`. The package has no postinstall, so the browser binary must be fetched once — without it, browser tools fail on first use.
- Corrected a broken Credits link that pointed at a non-existent `earendil-works/pi-coding-agent` repo; now links the canonical `earendil-works/pi`.

### Changed
- README overhaul: added a Highlights section, merged Install and Setup into one procedural flow, standardized the pi / pi-fox wordmark to lowercase, aligned "Markdown" terminology, and trimmed redundancy.

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

[Unreleased]: https://github.com/vaniteav/pi-fox/compare/v1.0.6...HEAD
[1.0.6]: https://github.com/vaniteav/pi-fox/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/vaniteav/pi-fox/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/vaniteav/pi-fox/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/vaniteav/pi-fox/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/vaniteav/pi-fox/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/vaniteav/pi-fox/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/vaniteav/pi-fox/releases/tag/v1.0.0
