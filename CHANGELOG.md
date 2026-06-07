# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- `/web-switch` renamed to `/search` with expanded hub (switch, add, add-custom, remove, onboarding)
- Search provider management moved out of `/browser`; `/browser` now manages browser engine settings only (headless, supervised)
- `/search <provider-id>` for instant provider switching at runtime (e.g. `/search brave`)

### Added
- Custom search provider wizard — add any search API via `/search` → "Add custom provider" without editing source code
- `buildCustomProviderImpl()` — wraps user-defined config into a `ProviderImpl`, slots into the existing registry, fallback chain, and `/search` automatically
- Full `async function(query, n, apiKey, fetchJson)` transform contract — handles both request building and response parsing in one user-written function
- Live raw→mapped test loop in wizard (Step 3): shows raw API JSON and mapped `SearchResult` side by side, flags missing fields before saving
- Pi agent snippet in transform step — copyable prompt for getting transform help from your pi agent
- `fetchJsonCapturing` helper — captures raw API response during wizard test without affecting production search paths
- `TRANSFORM_DRAFT_PATH` template file at `~/.pi/web-cache/custom-provider-draft.js` — editable in any editor or via pi agent

### Dependencies
- `fetch_content` now uses [Turndown](https://github.com/mixmark-io/turndown) for HTML→Markdown conversion (replaces regex tag stripping). Falls back to plain text strip if Turndown throws on malformed HTML.
- `/browser` command handlers extracted to named async functions: `runProviderSwitch`, `runProviderAdd`, `runProviderRemove`, `runCustomProviderWizard`, `runCollectProviderMeta`, `runCollectTransform`, `runTestTransform`, `saveCustomProvider`
- `PROVIDER_REGISTRY` changed from `const` to `let` — rebuilt at startup with custom providers appended
- `ProviderId` widened to `"brave" | "perplexity" | "tavily" | "exa" | "gemini" | (string & {})` to support dynamic custom provider IDs

### Dependencies
- Added (dev): `@types/turndown` — TypeScript types for Turndown
- `turndown` was already listed in `package.json` and is now actively used
