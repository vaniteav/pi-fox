# Design: `/search` Command + Browser/Search Separation

**Date:** 2026-06-07
**Project:** pi-fox (`C:\Users\janic\Documents\pi\browser-extension`)
**Status:** Awaiting user review

---

## Problem

The current command surface has two issues:

1. `/web-switch` is named after the old package (`pi-web`) and doesn't describe what it does.
2. Search provider management (switch, add, add-custom, remove, onboarding wizard) is buried inside `/browser`, which is semantically wrong — these are search concerns, not browser concerns.

---

## Goal

Clean domain separation:

- **`/browser`** owns everything about the browser engine: headless mode, supervised mode, session status.
- **`/search`** owns everything about search: provider status, switching, adding, removing, onboarding.
- **`/web-switch`** is retired entirely.

---

## Command Designs

### `/search` (new)

**Invocation forms:**

| Invocation | Behaviour |
|---|---|
| `/search` | Opens the full search hub (status + management menu) |
| `/search <provider-id>` | Immediately switches to that provider (e.g. `/search brave`) |

**Argument handling — `/search <provider-id>`:**

- If provider ID matches a configured provider → switch immediately, notify "Switched to Brave. Run /reload to activate."
- If provider ID is unknown or not configured → three-line error:
  1. `"Search provider 'xyz' is not configured."`
  2. `"Your configured providers: brave, tavily"`
  3. `"Need to add one? Run /search → Add a provider, or ask me: 'add Exa as a search provider'"`

**Hub flow — `/search` (no args):**

```
Status block:
  Active provider: Tavily
  Configured providers: brave, tavily, exa

Management menu:
  → Switch active provider         (runProviderSwitch)
  → Add a provider                 (runProviderAdd)
  → Add custom provider            (runCustomProviderWizard)
  → Remove a provider              (runProviderRemove)
  → Done
```

**Onboarding flow — no providers configured:**

When no providers are configured, `/search` shows the onboarding prompt instead of the management menu. This moves from `/browser` to `/search` — it's a search concern.

```
⚠ No search providers configured. web_search and code_search are disabled.

Would you like to configure a search provider?
  → Brave Search — FREE (2,000 queries/mo)
  → Tavily — FREE (1,000 queries/mo)
  → Exa — FREE tier (2,500 queries/mo)
  → Google Gemini — free tier
  → Skip — configure later
```

---

### `/browser` (trimmed)

**Status block (browser-only):**

```
Browser Engine: firefox
Headless: true
Supervised: true
Session active: false
[Current page: <title> / URL: <url>  ← only shown when session active]
Search: tavily  ← read-only reference, no management
[Screenshot dir: <path>  ← only shown when supervised + active session]
```

**Management menu (browser-only):**

```
→ Headless: true → false    (toggle headless, run /reload to apply)
→ Supervised: true → false  (toggle supervised, run /reload to apply)
→ Done
```

All search-related menu options (Switch active provider, Add another provider, Add custom provider, Remove a provider) are removed from `/browser`.

The onboarding prompt for "no providers configured" is also removed from `/browser`.

---

## What Changes

### `index.ts`

| Location | Change |
|---|---|
| File header comment block (lines ~22–46) | Replace `/web-switch` references with `/search` |
| `web_search` / `code_search` tool error messages | "Run /browser for setup" → "Run /search for setup" |
| `runCustomProviderWizard` notify message (line ~1739) | "appear in /web-switch" → "appear in /search" |
| `/browser` command handler | Remove: onboarding block, switch/add/add-custom/remove menu options. Keep: status block (add read-only search line), headless toggle, supervised toggle. |
| `/web-switch` command registration | Delete entirely |
| New `/search` command registration | Add: argument handling, status block, management menu (calls existing handler functions), onboarding block (moved from `/browser`) |

### Handler functions

`runProviderSwitch`, `runProviderAdd`, `runProviderRemove`, `runCustomProviderWizard` — **no changes**. These functions stay exactly where they are; only their call sites change from `/browser` to `/search`.

### `README.md`

Commands section:

**Before:**
- `/browser` — Setup wizard + provider management: shows current config, detects configured keys, and lets you add, switch, or remove providers.
- `/web-switch` — Switch the active search provider at runtime without restarting.

**After:**
- `/browser` — Browser status and settings: engine, headless mode, supervised mode.
- `/search` — Search provider management: status, switch, add, remove, and onboarding wizard. Use `/search <provider-id>` to switch instantly at runtime.

### `CHANGELOG.md`

Add entry under a new version (or unreleased):

```
### Changed
- `/web-switch` renamed to `/search` with expanded hub (switch, add, add-custom, remove, onboarding)
- Search provider management moved out of `/browser`; `/browser` now manages browser engine settings only
- `/search <provider-id>` shortcut for instant provider switching at runtime
```

---

## What Does Not Change

- All 19 tools (15 browser + 4 web) — untouched
- `runProviderSwitch`, `runProviderAdd`, `runProviderRemove`, `runCustomProviderWizard` — untouched
- `getActiveConfig`, `patchExtConfig`, `PROVIDER_REGISTRY` — untouched
- `loadConfig`, `browserState`, all Playwright logic — untouched
- `.npmignore`, `.gitignore`, `package.json`, `LICENSE` — untouched

---

## Out of Scope

- Engine switching (Chromium/WebKit) — not currently in any command; not added here
- `/search list` or other subcommand variants — YAGNI
- Persisting provider order or priority — existing behaviour unchanged

---

## Success Criteria

- [ ] `/search` with no args shows status + full management menu
- [ ] `/search brave` switches immediately to Brave (if configured)
- [ ] `/search xyz` shows the three-line not-configured error with natural language prompt
- [ ] `/browser` shows browser-only status and headless/supervised toggles only
- [ ] No search options remain in `/browser`
- [ ] `/web-switch` no longer exists; attempting to run it gives pi's standard "unknown command" response
- [ ] All internal notify messages referencing `/web-switch` updated to `/search`
- [ ] README commands section updated
- [ ] CHANGELOG updated
- [ ] Extension loads clean with no errors after changes
