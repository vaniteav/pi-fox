# /search Command + Browser/Search Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/web-switch` with a proper `/search` hub command, move all search management out of `/browser`, and give `/browser` clean browser-only ownership.

**Architecture:** Single file refactor in `index.ts`. Four existing handler functions (`runProviderSwitch`, `runProviderAdd`, `runProviderRemove`, `runCustomProviderWizard`) are untouched — only their call sites change. The `/browser` command is trimmed to browser-only concerns. A new `/search` command is registered with argument support and onboarding. `/web-switch` is deleted.

**Tech Stack:** TypeScript, pi extension API (`pi.registerCommand`), Playwright, Node.js

---

## File Map

| File | Change |
|---|---|
| `index.ts` | String references, `/browser` handler, `/web-switch` deletion, `/search` addition |
| `README.md` | Commands section |
| `CHANGELOG.md` | Add entry |

---

### Task 1: Update string references — `/web-switch` → `/search` and `/browser` → `/search` for search-related messages

**Files:**
- Modify: `index.ts` (lines 23, 41, 46, 443, 1119, 1724, 1739, 1919)

- [ ] **Step 1: Replace file header references**

Find and replace these exact strings in the comment block at the top of `index.ts`:

```
FIND:    *   /web-switch    — Switch active search provider on the fly
REPLACE: *   /search        — Search provider management (hub + /search <id> quick switch)
```

```
FIND:    *   First configured key becomes active. Use /web-switch to change at runtime.
REPLACE: *   First configured key becomes active. Use /search to manage providers at runtime.
```

```
FIND:    *   /web-switch — switch active provider
REPLACE: *   /search     — search provider management
```

- [ ] **Step 2: Update startup message (line ~443)**

```
FIND:    "Run /browser for the interactive setup wizard.";
REPLACE: "Run /search for the interactive setup wizard.";
```

- [ ] **Step 3: Update web_search tool description (line ~1119)**

```
FIND:    "Run /browser for the setup wizard, or set a key via env var or settings.json.",
REPLACE: "Run /search for the setup wizard, or set a key via env var or settings.json.",
```

- [ ] **Step 4: Update runCustomProviderWizard message (line ~1724)**

```
FIND:    ctx.ui.notify("Still failing. Saving anyway — run /browser → Remove to undo.", "warning");
REPLACE: ctx.ui.notify("Still failing. Saving anyway — run /search → Remove to undo.", "warning");
```

- [ ] **Step 5: Update runCustomProviderWizard final message (line ~1739)**

```
FIND:    `Run /reload to activate it. It will appear in /web-switch and the provider fallback chain.`,
REPLACE: `Run /reload to activate it. It will appear in /search and the provider fallback chain.`,
```

- [ ] **Step 6: Update startup warning message (line ~1919)**

```
FIND:    "Run /browser for the setup wizard (Brave Search = free, 2,000 queries/mo).",
REPLACE: "Run /search for the setup wizard (Brave Search = free, 2,000 queries/mo).",
```

- [ ] **Step 7: Verify no remaining `/web-switch` references**

Run:
```bash
grep -n "web-switch\|Web-switch\|webSwitch" index.ts
```
Expected: 0 matches (the `registerCommand("web-switch"` block still exists — that gets removed in Task 3, so it may appear here. That's fine — the goal is zero references in *string messages*.)

- [ ] **Step 8: Commit**

```bash
git add index.ts
git commit -m "refactor: update /web-switch and /browser search references to /search"
```

---

### Task 2: Replace `/browser` command with trimmed browser-only version

**Files:**
- Modify: `index.ts` — replace the entire `pi.registerCommand("browser", { ... })` block

- [ ] **Step 1: Locate the browser command block**

Run:
```bash
grep -n 'registerCommand("browser"' index.ts
```
Note the line number. The block runs from that line to the matching closing `});`.

- [ ] **Step 2: Replace the entire `/browser` command block**

Find the full existing block starting with `pi.registerCommand("browser", {` and ending with its closing `});`, and replace it with:

```typescript
	pi.registerCommand("browser", {
		description: "Browser status and settings (headless, supervised)",
		handler: async (_args, ctx) => {
			const cfg = loadConfig();
			const { active } = getActiveConfig(cfg);

			// ── Status block ──
			const running = browserState.browser !== null && browserState.page !== null && !browserState.page.isClosed();
			const url = running ? browserState.page!.url() : "N/A";
			const title = running ? await browserState.page!.title().catch(() => "N/A") : "N/A";

			const status = [
				`Browser Engine: ${browserState.engine}`,
				`Headless: ${browserState.headless}`,
				`Supervised: ${browserState.supervised}`,
				`Session active: ${running}`,
				running ? `Current page: ${title}\nURL: ${url}` : "",
				`Search: ${active?.id ?? "none configured — run /search"}`,
				browserState.supervised && browserState.sessionDir ? `Screenshot dir: ${browserState.sessionDir}` : "",
			].filter(Boolean).join("\n");
			ctx.ui.notify(status, "info");

			// ── Settings menu ──
			const choice = await ctx.ui.select(
				"Browser settings:",
				[
					{ value: "headless",   label: `Headless: ${browserState.headless} → ${!browserState.headless}`,       description: "Toggle visible/invisible browser. Run /reload to apply." },
					{ value: "supervised", label: `Supervised: ${browserState.supervised} → ${!browserState.supervised}`, description: "Auto-screenshot after each browser action. Run /reload to apply." },
					{ value: "done",       label: "Done",                                                                   description: "Exit" },
				],
			);

			switch (choice) {
				case "headless": {
					patchExtConfig({ headless: !browserState.headless });
					ctx.ui.notify(`Headless set to ${!browserState.headless}. Run /reload to apply.`, "info");
					break;
				}
				case "supervised": {
					patchExtConfig({ supervised: !browserState.supervised });
					ctx.ui.notify(`Supervised mode ${!browserState.supervised ? "ON" : "OFF"}. Run /reload to apply.`, "info");
					break;
				}
			}
		},
	});
```

- [ ] **Step 3: Verify `/browser` no longer references provider management**

Run:
```bash
grep -n "runProviderSwitch\|runProviderAdd\|runProviderRemove\|runCustomProviderWizard\|onboarding\|add-custom\|No search providers" index.ts | grep -v "^[0-9]*:.*function\|^[0-9]*:.*async function"
```
Expected: matches only in function definitions and the upcoming `/search` block (not yet added), not in the `/browser` handler.

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "refactor: trim /browser to browser-only status and settings"
```

---

### Task 3: Delete `/web-switch` and add `/search` command

**Files:**
- Modify: `index.ts` — delete `registerCommand("web-switch")` block, add `registerCommand("search")` block

- [ ] **Step 1: Delete the `/web-switch` command block**

Find the block starting with `pi.registerCommand("web-switch", {` and ending with its closing `});` and delete it entirely.

- [ ] **Step 2: Add the `/search` command block in its place**

Insert the following immediately where the `/web-switch` block was:

```typescript
	pi.registerCommand("search", {
		description: "Search provider management — status, switch, add, remove. Use /search <provider-id> to switch instantly.",
		handler: async (args, ctx) => {
			const cfg = loadConfig();
			const { providers, active } = getActiveConfig(cfg);

			// ── Direct switch: /search <provider-id> ──
			const arg = (args as string).trim().toLowerCase();
			if (arg) {
				const target = providers.find(p => p.id === arg);
				if (target) {
					patchExtConfig({ activeProvider: target.id as ProviderId });
					ctx.ui.notify(`Switched to ${target.label}. Run /reload to activate.`, "info");
				} else {
					ctx.ui.notify(`Search provider '${arg}' is not configured.`, "warning");
					ctx.ui.notify(
						providers.length > 0
							? `Your configured providers: ${providers.map(p => p.id).join(", ")}`
							: "No providers configured yet.",
						"info",
					);
					ctx.ui.notify(
						"Need to add one? Run /search → Add a provider, or ask me: 'add Exa as a search provider'",
						"info",
					);
				}
				return;
			}

			// ── Onboarding: no providers configured ──
			if (providers.length === 0) {
				ctx.ui.notify("⚠ No search providers configured. web_search and code_search are disabled.", "warning");

				const choice = await ctx.ui.select(
					"Would you like to configure a search provider?",
					[
						{ value: "brave",      label: "Brave Search — FREE (2,000 queries/mo)",  description: "Best free option. Sign up at brave.com/search/api/" },
						{ value: "tavily",     label: "Tavily — FREE (1,000 queries/mo)",         description: "Designed for AI agents. Sign up at app.tavily.com" },
						{ value: "exa",        label: "Exa — FREE tier (2,500 queries/mo)",       description: "Sign up at exa.ai" },
						{ value: "gemini",     label: "Google Gemini — free tier",                description: "Get key at aistudio.google.com/app/apikey" },
						{ value: "perplexity", label: "Perplexity AI — paid",                     description: "Get key at perplexity.ai/settings/api" },
						{ value: "skip",       label: "Skip — configure later",                   description: "You can run /search again anytime" },
					],
				);

				if (choice && choice !== "skip") {
					const def = PROVIDER_REGISTRY.find(p => p.id === choice);
					if (def) {
						ctx.ui.notify(`To use ${def.label}:`, "info");
						ctx.ui.notify(`1. Get a free key: ${def.signupUrl}`, "info");
						ctx.ui.notify(`2. Set it via one of these methods:`, "info");
						ctx.ui.notify(`   Shell (current session):   export ${def.envKey}="your-key-here"`, "info");
						ctx.ui.notify(`   Shell (persistent):        Add the above to ~/.bashrc`, "info");
						ctx.ui.notify(`   Windows (persistent):      setx ${def.envKey} "your-key-here"`, "info");
						ctx.ui.notify(`   Pi settings (persistent):  Edit ~/.pi/agent/settings.json:`, "info");
						ctx.ui.notify(`     { "browserExt": { "${def.envKey}": "your-key-here", "activeProvider": "${def.id}" } }`, "info");
						ctx.ui.notify(`3. Restart pi or run /reload for the key to take effect.`, "info");
					}
				} else {
					ctx.ui.notify("Skipped. Run /search anytime to configure a provider.", "info");
				}
				return;
			}

			// ── Hub: providers configured ──
			ctx.ui.notify(
				`Active provider: ${active?.label ?? "none"}\nConfigured providers: ${providers.map(p => p.id).join(", ")}`,
				"info",
			);

			const choice = await ctx.ui.select(
				`${active ? `Active: ${active.label}` : "No active provider"} · ${providers.length} configured · Options:`,
				[
					{ value: "switch",     label: "Switch active provider",   description: "Change which provider is used for web_search" },
					{ value: "add",        label: "Add a provider",           description: "Configure an additional search provider" },
					{ value: "add-custom", label: "Add custom provider",      description: "Wizard: add any search API without editing source" },
					{ value: "remove",     label: "Remove a provider key",    description: "Clear a provider's key from settings.json" },
					{ value: "done",       label: "Done",                     description: "Exit" },
				],
			);

			switch (choice) {
				case "switch":     await runProviderSwitch(ctx, providers); break;
				case "add":        await runProviderAdd(ctx, providers); break;
				case "add-custom": await runCustomProviderWizard(ctx); break;
				case "remove":     await runProviderRemove(ctx, cfg, providers); break;
			}
		},
	});
```

- [ ] **Step 3: Verify no remaining `web-switch` references anywhere**

Run:
```bash
grep -n "web-switch" index.ts
```
Expected: 0 matches.

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: add /search command, retire /web-switch, move search management out of /browser"
```

---

### Task 4: Update README and CHANGELOG

**Files:**
- Modify: `README.md` — commands section
- Modify: `CHANGELOG.md` — add entry

- [ ] **Step 1: Replace the Commands section in README.md**

Find:
```markdown
## Commands

- `/browser` — Setup wizard + provider management: shows current config, detects configured keys, and lets you add, switch, or remove providers.
- `/web-switch` — Switch the active search provider at runtime without restarting.
```

Replace with:
```markdown
## Commands

- `/browser` — Browser status and settings: engine, headless mode, supervised mode.
- `/search` — Search provider management: status, switch, add, remove, and onboarding wizard. Use `/search <provider-id>` to switch instantly at runtime (e.g. `/search brave`).
```

- [ ] **Step 2: Add CHANGELOG entry**

At the top of the changelog entries (after the header), add:

```markdown
## [Unreleased]

### Changed
- `/web-switch` renamed to `/search` with expanded hub (switch, add, add-custom, remove, onboarding)
- Search provider management moved out of `/browser`; `/browser` now manages browser engine settings only (headless, supervised)
- `/search <provider-id>` for instant provider switching at runtime (e.g. `/search brave`)
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: update commands section for /search, add CHANGELOG entry"
```

---

### Task 5: Sync to load path and smoke test

**Files:**
- Modify: `~/.pi/agent/extensions/pi-fox/index.ts` — sync from source

- [ ] **Step 1: Sync source to load path**

```bash
cp index.ts ~/.pi/agent/extensions/pi-fox/index.ts
```

- [ ] **Step 2: Verify extension loads clean**

Run:
```bash
pi -p "respond with exactly: LOADED OK"
```
Expected output includes `LOADED OK` with no errors. Zero conflict or load errors.

- [ ] **Step 3: Verify `/browser` shows browser-only status**

Run:
```bash
pi -p "/browser"
```
Expected: Status block shows Engine/Headless/Supervised/Session/Search (read-only). Menu shows Headless toggle, Supervised toggle, Done. No Switch/Add/Remove provider options.

- [ ] **Step 4: Verify `/search` shows search hub**

Run:
```bash
pi -p "/search"
```
Expected: Status block shows active provider and configured providers. Menu shows Switch/Add/Add custom/Remove/Done.

- [ ] **Step 5: Verify `/search <provider-id>` direct switch**

Run:
```bash
pi -p "/search tavily"
```
Expected: `Switched to Tavily. Run /reload to activate.` — no menu shown.

- [ ] **Step 6: Verify `/search <unknown>` error message**

Run:
```bash
pi -p "/search xyz"
```
Expected: Three lines —
1. `Search provider 'xyz' is not configured.`
2. `Your configured providers: brave, tavily` (or whatever is configured)
3. `Need to add one? Run /search → Add a provider, or ask me: 'add Exa as a search provider'`

- [ ] **Step 7: Verify `/web-switch` is gone**

Run:
```bash
pi -p "/web-switch"
```
Expected: pi's standard unknown command response — not a handler error.

---

## Success Criteria Checklist

- [ ] `/search` with no args shows status + full management menu
- [ ] `/search brave` switches immediately to Brave (if configured)
- [ ] `/search xyz` shows the three-line not-configured error with natural language prompt
- [ ] `/browser` shows browser-only status and headless/supervised toggles only
- [ ] No search options remain in `/browser`
- [ ] `/web-switch` no longer exists
- [ ] All internal messages referencing `/web-switch` updated to `/search`
- [ ] README commands section updated
- [ ] CHANGELOG updated
- [ ] Extension loads clean with no errors
