/**
 * Pi Browser + Web Access Extension
 *
 * Author: vanitea
 *
 * Unified extension providing browser automation (via Playwright) and web access
 * (search, content fetching, code search) in a single package.
 *
 * ── Browser Tools (Playwright, Firefox default) ──
 *   browser_navigate, browser_click, browser_type, browser_snapshot,
 *   browser_screenshot, browser_evaluate, browser_wait,
 *   browser_tab_list, browser_tab_new, browser_tab_close, browser_tab_select,
 *   browser_back, browser_forward, browser_reload, browser_close
 *
 * ── Web Tools ──
 *   web_search     — AI-powered web search (Brave / Perplexity / Tavily / Exa / Gemini)
 *   code_search    — Code examples, docs, API references
 *   fetch_content  — Fetch and extract readable content from URLs
 *   get_search_content — Retrieve previously fetched/stored content
 *
 * ── Commands ──
 *   /browser       — Onboarding wizard, provider status, and usage help
 *   /web-switch    — Switch active search provider on the fly
 *
 * Configuration — set ONE or MORE:
 *
 *   Priority: settings.json > environment variable
 *
 *   Storage options (any method that results in the env var being set works):
 *     • Shell:        export BRAVE_API_KEY="..." (or setx on Windows)
 *     • pi settings:  ~/.pi/agent/settings.json → { "browserExt": { "BRAVE_API_KEY": "..." } }
 *     • Cloud env:    gh secrets, Railway, Render, Fly — all inject env vars
 *
 *   Provider keys (free tier available for all):
 *     BRAVE_API_KEY      — Brave Search    (free: 2,000/mo)  ★ recommended free option
 *     PERPLEXITY_API_KEY — Perplexity AI    (paid)
 *     TAVILY_API_KEY     — Tavily           (free: 1,000/mo)
 *     EXA_API_KEY        — Exa              (free: 2,500/mo)
 *     GEMINI_API_KEY     — Google Gemini    (free tier) — prepaid credits depleted
 *
 *   First configured key becomes active. Use /web-switch to change at runtime.
 *
 * Usage:
 *   pi -e ~/.pi/agent/extensions/pi-web/index.ts
 *   /browser    — first-run onboarding wizard
 *   /web-switch — switch active provider
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import TurndownService from "turndown";

// Stateless singleton — do not call addRule() here; create a new instance for per-call customization.
const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});

// ===========================================================================
// SECTION 0 — Core Types & Utilities
// ===========================================================================

// ── Type definitions ──

type ProviderId = "brave" | "perplexity" | "tavily" | "exa" | "gemini" | (string & {});

/** Typed view of settings.json → browserExt block */
interface ExtConfig {
	BRAVE_API_KEY?: string;
	PERPLEXITY_API_KEY?: string;
	TAVILY_API_KEY?: string;
	EXA_API_KEY?: string;
	GEMINI_API_KEY?: string;
	activeProvider?: ProviderId;
	supervised?: boolean;
	headless?: boolean;
	suppressStartupMessage?: boolean;
	customProviders?: CustomProviderConfig[];
}

/** Settings snapshot — read once per tool call, passed everywhere. Zero extra disk reads. */
interface Config {
	raw: Record<string, unknown>;
	ext: ExtConfig;
}

/** Explicit success/failure — errors collected and surfaced, never swallowed. */
type Result<T> = { ok: true; value: T } | { ok: false; error: string; provider?: string };

interface SearchResult {
	answer: string;
	results: Array<{ title: string; url: string; snippet: string }>;
}

/** One object per search provider. Add a new entry to PROVIDER_REGISTRY to add a provider. */
interface ProviderImpl {
	id: ProviderId;
	label: string;
	envKey: string;
	freeTier: string;
	signupUrl: string;
	hasKey(config: Config): boolean;
	search(query: string, n: number, config: Config): Promise<SearchResult>;
}

/** Config shape for a user-defined search provider stored in settings.json. */
interface CustomProviderConfig {
	id: string;
	label: string;
	envKey: string;
	freeTier: string;
	signupUrl: string;
	transform: string;
}

interface BrowserState {
	browser: import("playwright").Browser | null;
	context: import("playwright").BrowserContext | null;
	page: import("playwright").Page | null;
	engine: string;
	headless: boolean;
	supervised: boolean;
	sessionDir: string;
	viewport: { width: number; height: number };
}

// ── Settings ──

const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");

/** Read settings.json once. Pass the returned Config to all functions that need it. */
function loadConfig(): Config {
	try {
		const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Record<string, unknown>;
		const ext = (raw.browserExt ?? {}) as ExtConfig;
		return { raw, ext };
	} catch {
		return { raw: {}, ext: {} };
	}
}

/** Single write path for all settings mutations. Replaces 5 duplicated read-cast-spread-write blocks. */
function patchExtConfig(patch: Partial<ExtConfig>): void {
	const config = loadConfig();
	const updated: ExtConfig = { ...config.ext, ...patch };
	mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
	writeFileSync(SETTINGS_FILE, JSON.stringify({ ...config.raw, browserExt: updated }, null, 2));
}

// ── HTTP ──

/**
 * Async HTTP JSON fetch — replaces all execFileSync("curl") calls.
 * Uses Node 18+ native fetch. Does not block the event loop.
 * Throws on non-2xx with the HTTP status and truncated body for debugging.
 */
async function fetchJson<T>(url: string, options?: {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	timeout?: number;
}): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options?.timeout ?? 15000);
	try {
		const res = await fetch(url, {
			method: options?.method,
			headers: options?.headers,
			body: options?.body,
			signal: controller.signal,
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`HTTP ${res.status}: ${body.substring(0, 200)}`);
		}
		return await res.json() as T;
	} finally {
		clearTimeout(timer);
	}
}

// ── Tool helpers ──

/** Standard error response — replaces 19 duplicated error construction blocks. */
function toolError(text: string, extras?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details: { error: text, ...extras },
		isError: true as const,
	};
}

/**
 * Wraps a browser tool's core logic with the supervised screenshot lifecycle.
 * Replaces 5 duplicated _ss/_ssNote/_det blocks.
 * BUG-2 fix: uses \u{1F4F8} (valid TS) not \U0001F4F8 (Python syntax).
 */
async function withSupervisedScreenshot(
	state: BrowserState,
	label: string,
	baseDetails: Record<string, unknown>,
	fn: () => Promise<{ text: string; extraDetails?: Record<string, unknown> }>,
) {
	const { text, extraDetails } = await fn();
	const ss = await takeSupervisedScreenshot(state, label);
	const note = ss ? `\n[\u{1F4F8} ${ss}]` : "";
	const details = { ...baseDetails, ...extraDetails, ...(ss ? { screenshot: ss } : {}) };
	return {
		content: [{ type: "text" as const, text: text + note }],
		details,
	};
}

// ===========================================================================
// SECTION 1 — Browser State & Session Management
// ===========================================================================

function getEngine(): string {
	return (process.env.PI_BROWSER_ENGINE || "firefox").toLowerCase();
}

/**
 * BUG-3 fix: reads settings.browserExt.headless first (same pattern as getSupervised).
 * The old getHeadless() only read env vars, making the /browser headless toggle permanently inert.
 */
function getHeadless(config: Config): boolean {
	if (typeof config.ext.headless === "boolean") return config.ext.headless;
	const val = (process.env.PI_BROWSER_HEADLESS || "true").toLowerCase();
	return val !== "false" && val !== "0";
}

function getSupervised(config: Config): boolean {
	if (typeof config.ext.supervised === "boolean") return config.ext.supervised;
	const val = (process.env.PI_BROWSER_SUPERVISED || "true").toLowerCase();
	return val !== "false" && val !== "0";
}

function getViewport(config: Config): { width: number; height: number } {
	return {
		width: parseInt(process.env.PI_BROWSER_WIDTH || "1280", 10) || 1280,
		height: parseInt(process.env.PI_BROWSER_HEIGHT || "720", 10) || 720,
	};
}

/**
 * BUG-7 fix: creates the session directory lazily on first screenshot, not at extension load.
 * Called only from takeSupervisedScreenshot. Does nothing if sessionDir already set.
 */
function ensureSessionDir(state: BrowserState): string {
	if (!state.sessionDir) {
		const base = join(homedir(), "Pictures", "pi-web", "sessions");
		const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
		state.sessionDir = join(base, ts);
		mkdirSync(state.sessionDir, { recursive: true });
	}
	return state.sessionDir;
}

async function takeSupervisedScreenshot(state: BrowserState, label: string): Promise<string | null> {
	if (!state.supervised || !state.page || state.page.isClosed()) return null;
	try {
		const dir = ensureSessionDir(state);
		const safeName = label.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 40);
		const filename = `${Date.now()}_${safeName}.png`;
		const filepath = join(dir, filename);
		await state.page.screenshot({ path: filepath, type: "png" });
		return filepath;
	} catch {
		return null;
	}
}

/**
 * Returns existing page if open. Otherwise tears down any stale browser/context
 * (prevents process leaks on page crash) and launches a fresh session.
 */
async function getPage(state: BrowserState): Promise<import("playwright").Page> {
	if (state.page && !state.page.isClosed()) return state.page;
	// Tear down stale context/browser before relaunching
	await closeBrowser(state);
	const playwright = await import("playwright");
	const launcher = playwright[state.engine as "firefox" | "chromium" | "webkit"] ?? playwright.firefox;
	state.browser = await launcher.launch({ headless: state.headless });
	state.context = await state.browser.newContext({
		viewport: state.viewport,
		ignoreHTTPSErrors: true,
	});
	state.page = await state.context.newPage();
	return state.page;
}

/** BUG-5 fix: resets sessionDir so the next browser session gets a fresh timestamped directory. */
async function closeBrowser(state: BrowserState) {
	try { await state.context?.close(); } catch { /* ignore */ }
	try { await state.browser?.close(); } catch { /* ignore */ }
	state.browser = null;
	state.context = null;
	state.page = null;
	state.sessionDir = "";
}

// ── Browser tool schemas ──

const NavigateParams = Type.Object({
	url: Type.String({ description: "URL to navigate to, e.g. https://example.com" }),
	waitUntil: Type.Optional(Type.String({ description: "When to consider navigation done: 'load', 'domcontentloaded', or 'networkidle'. Default: 'load'" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Default: 30000" })),
});

const ClickParams = Type.Object({
	selector: Type.String({ description: "CSS selector or element role to click, e.g. 'button.login', 'text=Submit', 'css=#submit-btn'" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in ms. Default: 10000" })),
});

const TypeParams = Type.Object({
	selector: Type.String({ description: "CSS selector for the input element, e.g. 'input[name=email]', '#search-box'" }),
	text: Type.String({ description: "Text to type" }),
	delay: Type.Optional(Type.Number({ description: "Delay between keystrokes in ms. Default: 0" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in ms. Default: 10000" })),
});

const SnapshotParams = Type.Object({
	compact: Type.Optional(Type.Boolean({ description: "Return compact snapshot (default: true)" })),
});

const ScreenshotParams = Type.Object({
	fullPage: Type.Optional(Type.Boolean({ description: "Capture full page. Default: false" })),
	selector: Type.Optional(Type.String({ description: "CSS selector to screenshot specific element" })),
	format: Type.Optional(Type.String({ description: "Image format: 'png' or 'jpeg'. Default: 'png'" })),
});

const EvaluateParams = Type.Object({
	script: Type.String({ description: "JavaScript expression to evaluate in the page context" }),
});

const WaitParams = Type.Object({
	selector: Type.Optional(Type.String({ description: "CSS selector to wait for" })),
	timeout: Type.Optional(Type.Number({ description: "Wait timeout in milliseconds. Default: 10000" })),
	state: Type.Optional(Type.String({ description: "Wait state: 'attached', 'visible', 'hidden', 'detached'. Default: 'visible'" })),
});

const TabSelectParams = Type.Object({
	index: Type.Number({ description: "Zero-based tab index to switch to" }),
});

const TabNewParams = Type.Object({
	url: Type.Optional(Type.String({ description: "Optional URL to navigate to in the new tab" })),
});

// ===========================================================================
// SECTION 2 — Web Search & Content Fetching
// ===========================================================================

const WEB_CACHE_DIR = join(homedir(), ".pi", "web-cache");

function ensureCacheDir() {
	if (!existsSync(WEB_CACHE_DIR)) {
		mkdirSync(WEB_CACHE_DIR, { recursive: true });
	}
}

function cacheKey(prefix: string, input: string): string {
	// Use a simple hash for cache filenames
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
	}
	return `${prefix}_${Math.abs(hash).toString(36)}`;
}

function urlToCacheKey(url: string): string {
	// Create a filesystem-safe key from a URL
	return url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 100);
}

function cachePath(key: string): string {
	ensureCacheDir();
	return join(WEB_CACHE_DIR, `${key}.json`);
}

function storeCache(key: string, data: Record<string, unknown>) {
	writeFileSync(cachePath(key), JSON.stringify(data, null, 2));
}

function loadCache(key: string): Record<string, unknown> | null {
	const p = cachePath(key);
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch {
		return null;
	}
}

/** EFF-4 fix: O(1) direct key lookup — urlToCacheKey already provides the deterministic filename. */
function findCacheByUrl(url: string): Record<string, unknown> | null {
	return loadCache(`fetch_${urlToCacheKey(url)}`);
}

// ── Provider registry ──

const NO_PROVIDER_MSG =
	"No search provider configured. web_search and code_search require an API key.\n\n" +
	"Set your key via any of these methods:\n" +
	'  Shell:     export BRAVE_API_KEY="..."  (add to ~/.bashrc for persistence)\n' +
	'  Windows:   setx BRAVE_API_KEY "..."\n' +
	`  Pi config: edit ~/.pi/agent/settings.json → { "browserExt": { "BRAVE_API_KEY": "..." } }\n\n` +
	"Available providers with free tiers:\n" +
	"  Brave (2,000/mo)     https://brave.com/search/api/\n" +
	"  Tavily (1,000/mo)    https://app.tavily.com/\n" +
	"  Exa (2,500/mo)       https://exa.ai/\n" +
	"  Gemini (free tier)   https://aistudio.google.com/app/apikey\n" +
	"  Perplexity (paid)    https://www.perplexity.ai/settings/api\n\n" +
	"Run /browser for the interactive setup wizard.";

const braveProvider: ProviderImpl = {
	id: "brave", label: "Brave Search", envKey: "BRAVE_API_KEY",
	freeTier: "2,000 queries/mo", signupUrl: "https://brave.com/search/api/",
	hasKey(config) { return !!config.ext.BRAVE_API_KEY; },
	async search(query, n, config) {
		const key = config.ext.BRAVE_API_KEY!;
		const url = new URL("https://api.search.brave.com/res/v1/web/search");
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(n));
		const data = await fetchJson<{
			web?: { results?: Array<{ title: string; url: string; description?: string }> };
		}>(url.toString(), {
			headers: { "Accept": "application/json", "X-Subscription-Token": key },
		});
		const results = (data.web?.results ?? []).slice(0, n).map(r => ({
			title: r.title, url: r.url, snippet: r.description ?? "",
		}));
		return {
			answer: results.length
				? `Search results for "${query}" (${results.length} results)`
				: `No results found for "${query}"`,
			results,
		};
	},
};

const tavilyProvider: ProviderImpl = {
	id: "tavily", label: "Tavily", envKey: "TAVILY_API_KEY",
	freeTier: "1,000 queries/mo", signupUrl: "https://app.tavily.com/",
	hasKey(config) { return !!config.ext.TAVILY_API_KEY; },
	async search(query, n, config) {
		const key = config.ext.TAVILY_API_KEY!;
		const data = await fetchJson<{
			answer?: string;
			results?: Array<{ title: string; url: string; content?: string }>;
		}>("https://api.tavily.com/search", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
			body: JSON.stringify({ query, max_results: n, include_answer: true }),
		});
		const results = (data.results ?? []).map(r => ({
			title: r.title, url: r.url, snippet: (r.content ?? "").substring(0, 300),
		}));
		return { answer: data.answer ?? "", results };
	},
};

const exaProvider: ProviderImpl = {
	id: "exa", label: "Exa", envKey: "EXA_API_KEY",
	freeTier: "2,500 queries/mo", signupUrl: "https://exa.ai/",
	hasKey(config) { return !!config.ext.EXA_API_KEY; },
	async search(query, n, config) {
		const key = config.ext.EXA_API_KEY!;
		const data = await fetchJson<{
			results?: Array<{ title?: string; url: string; text?: string }>;
		}>("https://api.exa.ai/search", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Api-Key": key },
			body: JSON.stringify({ query, numResults: n, type: "auto", contents: { text: true } }),
		});
		const results = (data.results ?? []).map(r => ({
			title: r.title ?? r.url, url: r.url, snippet: (r.text ?? "").substring(0, 300),
		}));
		return { answer: "", results };
	},
};

const geminiProvider: ProviderImpl = {
	id: "gemini", label: "Google Gemini", envKey: "GEMINI_API_KEY",
	freeTier: "free tier", signupUrl: "https://aistudio.google.com/app/apikey",
	hasKey(config) { return !!config.ext.GEMINI_API_KEY; },
	async search(query, _n, config) {
		const key = config.ext.GEMINI_API_KEY!;
		const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
		const data = await fetchJson<{
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
		}>(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ contents: [{ parts: [{ text: query }] }] }),
		});
		const answer = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "(no answer)";
		return { answer, results: [] };
	},
};

const perplexityProvider: ProviderImpl = {
	id: "perplexity", label: "Perplexity AI", envKey: "PERPLEXITY_API_KEY",
	freeTier: "—", signupUrl: "https://www.perplexity.ai/settings/api",
	hasKey(config) { return !!config.ext.PERPLEXITY_API_KEY; },
	async search(query, n, config) {
		const key = config.ext.PERPLEXITY_API_KEY!;
		const data = await fetchJson<{
			choices?: Array<{ message?: { content?: string } }>;
			citations?: string[];
		}>("https://api.perplexity.ai/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
			body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: query }], max_tokens: 1024 }),
		});
		const answer = data.choices?.[0]?.message?.content ?? "(no answer)";
		const results = (data.citations ?? []).slice(0, n).map((url, i) => ({
			title: `Source ${i + 1}`, url, snippet: "",
		}));
		return { answer, results };
	},
};

/**
 * Wraps a CustomProviderConfig from settings.json into a live ProviderImpl.
 * The transform string is a full async search() implementation — it handles both
 * request building and response parsing. Compile and runtime errors are surfaced
 * separately so the user knows whether their syntax or their field mapping is broken.
 */
function buildCustomProviderImpl(cfg: CustomProviderConfig): ProviderImpl {
	return {
		id: cfg.id,
		label: cfg.label,
		envKey: cfg.envKey,
		freeTier: cfg.freeTier,
		signupUrl: cfg.signupUrl,
		hasKey(config) {
			return !!(config.ext as Record<string, unknown>)[cfg.envKey] ||
				!!process.env[cfg.envKey];
		},
		async search(query, n, config) {
			const apiKey = String(
				(config.ext as Record<string, unknown>)[cfg.envKey] ||
				process.env[cfg.envKey] || ""
			);
			type TransformFn = (q: string, n: number, k: string, f: typeof fetchJson) => Promise<SearchResult>;
			let fn: TransformFn;
			try {
				fn = new Function(
					"query", "n", "apiKey", "fetchJson",
					`return (${cfg.transform})(query, n, apiKey, fetchJson)`
				) as TransformFn;
			} catch (err) {
				throw new Error(`Transform compile error in "${cfg.label}": ${err instanceof Error ? err.message : String(err)}`);
			}
			try {
				return await fn(query, n, apiKey, fetchJson);
			} catch (err) {
				throw new Error(`Transform runtime error in "${cfg.label}": ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	};
}

/** To add a new provider: add one ProviderImpl object here. Nothing else changes. */
const PROVIDER_REGISTRY: ProviderImpl[] = [
	braveProvider, tavilyProvider, exaProvider, geminiProvider, perplexityProvider,
];

/**
 * Returns configured providers and the active one.
 * Single call per tool invocation — no extra disk reads.
 * STRUCT-1 fix: "none" never appears in typed arrays.
 */
function getActiveConfig(config: Config): { providers: ProviderImpl[]; active: ProviderImpl | undefined } {
	const providers = PROVIDER_REGISTRY.filter(p => p.hasKey(config));
	const active = providers.find(p => p.id === config.ext.activeProvider) ?? providers[0];
	return { providers, active };
}

/**
 * BUG-1 fix: recency is appended to fullQuery (not bare query) so domain filter is preserved.
 * EFF-1 fix: accepts Config — no extra disk reads inside.
 * Collects provider failures into debugInfo instead of swallowing them.
 */
async function performSearch(
	query: string,
	n: number,
	preferred: string | undefined,
	recency: string | undefined,
	domainFilter: string[] | undefined,
	config: Config,
): Promise<{ answer: string; results: Array<{ title: string; url: string; snippet: string }>; provider: string; debugInfo: string[] }> {
	// Build fullQuery — apply domain filter first, then recency (both on fullQuery, not bare query)
	let fullQuery = query;
	if (domainFilter?.length) {
		const sites = domainFilter.map(d => d.startsWith("-") ? `-site:${d.slice(1)}` : `site:${d}`).join(" ");
		fullQuery = `${fullQuery} ${sites}`;
	}
	if (recency) fullQuery = `${fullQuery} (${recency})`;

	const { providers, active } = getActiveConfig(config);
	if (!active) return { answer: NO_PROVIDER_MSG, results: [], provider: "none", debugInfo: [] };

	// Preferred provider first, then remaining configured providers as fallback
	const preferredImpl = preferred && preferred !== "auto"
		? providers.find(p => p.id === preferred)
		: undefined;
	const ordered = preferredImpl
		? [preferredImpl, ...providers.filter(p => p.id !== preferredImpl.id)]
		: [active, ...providers.filter(p => p.id !== active.id)];

	const debugInfo: string[] = [];
	for (const provider of ordered) {
		try {
			const value = await provider.search(fullQuery, n, config);
			return { ...value, provider: provider.id, debugInfo };
		} catch (err) {
			debugInfo.push(`${provider.id}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return {
		answer: `All providers failed.\n\nTried:\n${debugInfo.map(d => `  • ${d}`).join("\n")}\n\n${NO_PROVIDER_MSG}`,
		results: [], provider: "none", debugInfo,
	};
}

// ── Content fetching ──

/** Async URL content fetch — uses native fetch, no execFileSync, does not block event loop. */
async function fetchUrlContent(url: string): Promise<{ title: string; content: string; error?: string }> {
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const ct = res.headers.get("content-type") ?? "";
		if (!ct.includes("text/")) return { title: url, content: "", error: `Non-text content-type: ${ct}` };
		const html = await res.text();

		const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
		const title = titleMatch?.[1]?.trim() ?? url;

		// Strip non-content tags before Turndown conversion
		const cleaned = html
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

		let text: string;
		try {
			text = turndown.turndown(cleaned).trim();
		} catch {
			// Fallback: basic tag strip if Turndown fails on malformed HTML
			text = cleaned
				.replace(/<[^>]+>/g, " ")
				.replace(/&nbsp;/g, " ")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'")
				.replace(/&amp;/g, "&")
				.replace(/\s+/g, " ")
				.trim();
			text = "[Note: Markdown conversion failed — plain text fallback]\n\n" + text;
		}

		return { title, content: text };
	} catch (err) {
		return { title: url, content: "", error: err instanceof Error ? err.message : String(err) };
	}
}

// ── Web tool schemas ──

const WebSearchParams = Type.Object({
	query: Type.Optional(Type.String({ description: "Single search query. For research, prefer 'queries' with multiple varied angles." })),
	queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries for broader coverage. Vary phrasing and scope across 2-4 queries." })),
	numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
	includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content for results (async). Default: false" })),
	recencyFilter: Type.Optional(Type.String({ description: "Filter by recency: 'day', 'week', 'month', or 'year'" })),
	domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude, e.g. '-wikipedia.org')" })),
	provider: Type.Optional(Type.String({ description: "Search provider: 'auto' (default), 'brave', 'perplexity', 'tavily', 'exa', 'gemini'" })),
});

const CodeSearchParams = Type.Object({
	query: Type.String({ description: "Programming question, API, library, or debugging topic to search for" }),
	maxResults: Type.Optional(Type.Number({ description: "Max results to return (default: 10)" })),
});

const FetchContentParams = Type.Object({
	url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
	urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
});

const GetSearchContentParams = Type.Object({
	responseId: Type.Optional(Type.String({ description: "Response ID from a previous web_search or fetch_content call" })),
	url: Type.Optional(Type.String({ description: "URL to retrieve cached content for" })),
});

// ===========================================================================
// SECTION 3 — Extension Entry Point
// ===========================================================================

export default function browserWebExtension(pi: ExtensionAPI) {
	// ── Load config once — passed to all tools that need settings ──
	const config = loadConfig();

	// ── Browser state ──
	const browserState: BrowserState = {
		engine: getEngine(),
		headless: getHeadless(config),        // BUG-3 fix: reads settings.headless
		supervised: getSupervised(config),
		sessionDir: "",                        // BUG-7 fix: lazy — created on first screenshot
		viewport: getViewport(config),
		browser: null,
		context: null,
		page: null,
	};

	// =======================================================================
	// BROWSER TOOLS
	// =======================================================================

	pi.registerTool({
		name: "browser_navigate",
		label: "Browser Navigate",
		description: "Navigate the browser to a URL. Opens a new browser instance if none is running. Uses Firefox by default.",
		promptSnippet: "Navigate browser to a URL",
		promptGuidelines: ["Use browser_navigate to open a webpage. Always navigate before interacting with page elements."],
		parameters: NavigateParams,
		async execute(_toolCallId, params) {
			try {
				const page = await getPage(browserState);
				const wait = (params.waitUntil as "load" | "domcontentloaded" | "networkidle") ?? "load";
				await page.goto(params.url, { waitUntil: wait, timeout: params.timeout ?? 30000 });
				const title = await page.title();
				return await withSupervisedScreenshot(browserState, "navigate", { url: page.url(), title }, async () => ({
					text: `Navigated to ${params.url}\nTitle: ${title}\nURL: ${page.url()}`,
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Navigation failed: ${msg}`, { url: params.url });
			}
		},
	});

	pi.registerTool({
		name: "browser_click",
		label: "Browser Click",
		description: "Click an element on the page. Supports CSS selectors, text selectors (text=), role selectors, etc.",
		promptSnippet: "Click a page element by selector",
		promptGuidelines: ["Use browser_click after browser_navigate. Use browser_snapshot first to find the right selector."],
		parameters: ClickParams,
		async execute(_toolCallId, params) {
			try {
				const page = await getPage(browserState);
				await page.click(params.selector, { timeout: params.timeout ?? 10000 });
				return await withSupervisedScreenshot(browserState, "click", { selector: params.selector }, async () => ({
					text: `Clicked: ${params.selector}`,
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Click failed on "${params.selector}": ${msg}`, { selector: params.selector });
			}
		},
	});

	pi.registerTool({
		name: "browser_type",
		label: "Browser Type",
		description: "Type text into an input, textarea, or contenteditable element.",
		promptSnippet: "Type text into a form field or input element",
		promptGuidelines: ["Use browser_type to fill form fields."],
		parameters: TypeParams,
		async execute(_toolCallId, params) {
			try {
				const page = await getPage(browserState);
				await page.fill(params.selector, "", { timeout: params.timeout ?? 10000 });
				await page.type(params.selector, params.text, { delay: params.delay ?? 0, timeout: params.timeout ?? 10000 });
				return await withSupervisedScreenshot(browserState, "type", { selector: params.selector, text: params.text }, async () => ({
					text: `Typed into ${params.selector}: "${params.text}"`,
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Type failed on "${params.selector}": ${msg}`, { selector: params.selector });
			}
		},
	});

	pi.registerTool({
		name: "browser_snapshot",
		label: "Browser Snapshot",
		description: "Get the accessibility tree snapshot of the current page. Shows the page structure with roles, names, and states. Use this to understand what's on the page and find selectors.",
		promptSnippet: "Get page accessibility snapshot to see structure and find elements",
		promptGuidelines: ["Use browser_snapshot to understand page structure and find element selectors before browser_click or browser_type."],
		parameters: SnapshotParams,
		async execute(_toolCallId, _params) {
			try {
				const page = await getPage(browserState);
				let raw: string;
				try {
					raw = await page.locator("body").ariaSnapshot() ?? "(empty page)";
				} catch {
					raw = "(could not get page snapshot)";
				}
				return await withSupervisedScreenshot(browserState, "snapshot", { length: raw.length, url: page.url() }, async () => ({
					text: raw.substring(0, 8000) + (raw.length > 8000 ? "\n... (truncated)" : ""),
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Snapshot failed: ${msg}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description: "Take a screenshot of the current page. Returns a base64-encoded PNG/JPEG image that the model can see.",
		promptSnippet: "Take a screenshot of the current page",
		promptGuidelines: ["Use browser_screenshot to visually inspect the current page state."],
		parameters: ScreenshotParams,
		async execute(_toolCallId, params) {
			try {
				const page = await getPage(browserState);
				const format = (params.format as "png" | "jpeg") ?? "png";
				// BUG-4 fix: use locator when selector provided — element-scoped screenshot
				const target = params.selector
					? page.locator(params.selector as string)
					: page;
				// fullPage only applies to full-page screenshots; Locator.screenshot() doesn't support it
				const buffer = params.selector
					? await target.screenshot({ type: format })
					: await target.screenshot({ fullPage: params.fullPage ?? false, type: format });
				const base64 = buffer.toString("base64");
				return {
					content: [
						{ type: "text" as const, text: `Screenshot taken (${format}, ${buffer.length} bytes)${params.selector ? ` [selector: ${params.selector}]` : ""}` },
						{ type: "image" as const, source: { type: "base64" as const, mediaType: `image/${format}`, data: base64 } },
					],
					details: { format, size: buffer.length, url: page.url(), selector: (params.selector as string) ?? null },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Screenshot failed: ${msg}`, { selector: params.selector as string | undefined });
			}
		},
	});

	pi.registerTool({
		name: "browser_evaluate",
		label: "Browser Evaluate",
		description: "Run JavaScript code in the page context and return the result. Use to extract data, manipulate the DOM, or query values.",
		promptSnippet: "Run JavaScript in the current page",
		promptGuidelines: ["Use browser_evaluate to extract data from the page, check state, or perform custom DOM operations."],
		parameters: EvaluateParams,
		async execute(_toolCallId, params) {
			try {
				const page = await getPage(browserState);
				const result = await page.evaluate(params.script);
				const output = typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);
				return await withSupervisedScreenshot(browserState, "evaluate", { resultType: typeof result }, async () => ({
					text: output.substring(0, 8000) + (output.length > 8000 ? "\n... (truncated)" : ""),
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Evaluate failed: ${msg}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_wait",
		label: "Browser Wait",
		description: "Wait for an element to appear/disappear or wait for a timeout. Useful after clicks that cause page transitions.",
		promptSnippet: "Wait for an element or a timeout before proceeding",
		promptGuidelines: ["Use browser_wait after actions that cause page changes (clicks, form submissions)."],
		parameters: WaitParams,
		async execute(_toolCallId, params) {
			try {
				const page = await getPage(browserState);
				if (params.selector) {
					const waitState = (params.state as "attached" | "visible" | "hidden" | "detached") || "visible";
					await page.waitForSelector(params.selector, { state: waitState, timeout: params.timeout || 10000 });
					return { content: [{ type: "text" as const, text: `Element "${params.selector}" reached state "${waitState}"` }], details: { selector: params.selector, state: waitState } };
				} else if (params.timeout) {
					await page.waitForTimeout(params.timeout);
					return { content: [{ type: "text" as const, text: `Waited ${params.timeout}ms` }], details: { timeout: params.timeout } };
				}
				return { content: [{ type: "text" as const, text: "Nothing to wait for" }], details: {} };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `Wait failed: ${msg}` }], details: { error: msg }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "browser_tab_list",
		label: "Browser Tab List",
		description: "List all open tabs/pages with their index, URL, and title.",
		promptSnippet: "List all open browser tabs",
		promptGuidelines: ["Use browser_tab_list to see all open tabs when working with multiple pages."],
		parameters: Type.Object({}),
		async execute() {
			try {
				if (!browserState.context) return { content: [{ type: "text" as const, text: "No browser session open" }], details: {} };
				const pages = browserState.context.pages();
				const tabs = await Promise.all(pages.map(async (p, i) => ({
					index: i, url: p.url(), title: await p.title().catch(() => "(loading)"),
				})));
				const lines = tabs.map(t => `[${t.index}] ${t.title}\n     ${t.url}`);
				return { content: [{ type: "text" as const, text: tabs.length ? lines.join("\n") : "No tabs open" }], details: { tabCount: tabs.length, tabs } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `Tab list failed: ${msg}` }], details: { error: msg }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "browser_tab_new",
		label: "Browser Tab New",
		description: "Open a new tab and switch to it.",
		promptSnippet: "Open a new browser tab",
		promptGuidelines: [],
		parameters: TabNewParams,
		async execute(_toolCallId, params) {
			try {
				await getPage(browserState);
				const newPage = await browserState.context!.newPage();
				if (params.url) await newPage.goto(params.url, { waitUntil: "load", timeout: 30000 });
				browserState.page = newPage;
				const idx = browserState.context!.pages().length - 1;
				return { content: [{ type: "text" as const, text: `Opened new tab [${idx}]${params.url ? `: ${params.url}` : ""}` }], details: { index: idx, url: params.url } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `New tab failed: ${msg}` }], details: { error: msg }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "browser_tab_close",
		label: "Browser Tab Close",
		description: "Close the current tab. Switches to another tab if available.",
		promptSnippet: "Close the current browser tab",
		promptGuidelines: [],
		parameters: Type.Object({}),
		async execute() {
			try {
				const pages = browserState.context?.pages() ?? [];
				if (pages.length <= 1) {
					await closeBrowser(browserState);
					return { content: [{ type: "text" as const, text: "Closed the last tab. Browser session ended." }], details: {} };
				}
				if (!browserState.page) return toolError("No active page to close");
				const currentIdx = pages.indexOf(browserState.page);
				await browserState.page.close();
				// Re-fetch pages after close — stale snapshot would reference the closed page
				const remaining = browserState.context!.pages();
				const newIdx = Math.max(0, Math.min(currentIdx - 1, remaining.length - 1));
				browserState.page = remaining[newIdx] ?? remaining[0];
				return {
					content: [{ type: "text" as const, text: `Closed tab. Switched to tab [${newIdx}]: ${browserState.page?.url()}` }],
					details: { newIndex: newIdx },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Close tab failed: ${msg}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_tab_select",
		label: "Browser Tab Select",
		description: "Switch to a specific tab by its index.",
		promptSnippet: "Switch to a specific browser tab by index",
		promptGuidelines: [],
		parameters: TabSelectParams,
		async execute(_toolCallId, params) {
			try {
				const pages = browserState.context?.pages() || [];
				if (params.index < 0 || params.index >= pages.length) {
					return { content: [{ type: "text" as const, text: `Tab index ${params.index} out of range. ${pages.length} tabs open (0-${pages.length - 1})` }], details: { error: "out of range" }, isError: true };
				}
				browserState.page = pages[params.index];
				return { content: [{ type: "text" as const, text: `Switched to tab [${params.index}]: ${(await browserState.page?.title()) || "(loading)"} - ${browserState.page?.url()}` }], details: { index: params.index } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `Tab select failed: ${msg}` }], details: { error: msg }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "browser_back",
		label: "Browser Back",
		description: "Navigate back in browser history.",
		promptSnippet: "Go back in browser history",
		promptGuidelines: [],
		parameters: Type.Object({}),
		async execute() {
			try {
				const page = await getPage(browserState);
				await page.goBack({ waitUntil: "load", timeout: 15000 });
				return { content: [{ type: "text" as const, text: `Went back → ${page.url()}` }], details: { url: page.url() } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `Back failed: ${msg}` }], details: { error: msg }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "browser_forward",
		label: "Browser Forward",
		description: "Navigate forward in browser history.",
		promptSnippet: "Go forward in browser history",
		promptGuidelines: [],
		parameters: Type.Object({}),
		async execute() {
			try {
				const page = await getPage(browserState);
				await page.goForward({ waitUntil: "load", timeout: 15000 });
				return { content: [{ type: "text" as const, text: `Went forward → ${page.url()}` }], details: { url: page.url() } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `Forward failed: ${msg}` }], details: { error: msg }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "browser_reload",
		label: "Browser Reload",
		description: "Reload the current page.",
		promptSnippet: "Reload the current page",
		promptGuidelines: [],
		parameters: Type.Object({}),
		async execute() {
			try {
				const page = await getPage(browserState);
				await page.reload({ waitUntil: "load", timeout: 30000 });
				return { content: [{ type: "text" as const, text: `Reloaded: ${page.url()}` }], details: { url: page.url() } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `Reload failed: ${msg}` }], details: { error: msg }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "browser_close",
		label: "Browser Close",
		description: "Close the entire browser session and all tabs.",
		promptSnippet: "Close the browser",
		promptGuidelines: [],
		parameters: Type.Object({}),
		async execute() {
			await closeBrowser(browserState);
			return { content: [{ type: "text" as const, text: "Browser closed." }], details: {} };
		},
	});

	// =======================================================================
	// WEB SEARCH TOOLS
	// =======================================================================

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using Brave, Perplexity, Tavily, Exa, or Gemini. Returns an AI-synthesized answer with source citations. " +
			"For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query. " +
			"Provider auto-selects from configured API keys. " +
			"Run /browser for the setup wizard, or set a key via env var or settings.json.",
		promptSnippet: "Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query.",
		parameters: WebSearchParams,
		async execute(_toolCallId, params) {
			const cfg = loadConfig();
			const queries = params.queries?.length ? params.queries : (params.query ? [params.query] : []);
			if (!queries.length) {
				return toolError("No query provided. Use 'query' or 'queries' parameter.");
			}

			const numResults = (params.numResults as number) ?? 5;

			// EFF-3 fix: performSearch is now async (native fetch), so Promise.all is truly parallel
			const allResults = await Promise.all(
				queries.map(q => performSearch(
					q, numResults,
					params.provider as string | undefined,
					params.recencyFilter as string | undefined,
					params.domainFilter as string[] | undefined,
					cfg,
				))
			);

			// Format output
			let output = "";
			for (let i = 0; i < allResults.length; i++) {
				const r = allResults[i];
				if (allResults.length > 1) output += `## Query: "${queries[i]}" [${r.provider}]\n\n`;
				if (r.answer) output += `${r.answer}\n\n`;
				if (r.results.length) {
					output += "---\n**Sources:**\n";
					for (let j = 0; j < r.results.length; j++) {
						const s = r.results[j];
						output += `${j + 1}. ${s.title}\n   ${s.url}\n`;
						if (s.snippet) output += `   ${s.snippet}\n`;
					}
					output += "\n";
				}
			}

			// Cache results
			const responseId = cacheKey("search", queries.join("|"));
			storeCache(responseId, {
				type: "search",
				queries: allResults.map((r, i) => ({ query: queries[i], ...r })),
				timestamp: Date.now(),
			});

			// Background content fetch — genuinely parallel now that fetchUrlContent is async
			const topUrls = allResults.flatMap(r => r.results.slice(0, 3).map(s => s.url));
			if ((params.includeContent as boolean) && topUrls.length) {
				output += `---\nCaching content for ${topUrls.length} URLs in background...\n`;
				Promise.all(topUrls.map(u => fetchUrlContent(u))).then(contents => {
					const fetchId = cacheKey("fetch", topUrls.join("|"));
					storeCache(fetchId, { type: "fetch", urls: contents, timestamp: Date.now() });
				}).catch(() => { /* background errors ignored */ });
			}

			return {
				content: [{ type: "text" as const, text: output.trim() }],
				details: {
					queries,
					queryCount: queries.length,
					provider: allResults[0]?.provider ?? "none",
					responseId,
					totalResults: allResults.reduce((sum, r) => sum + r.results.length, 0),
					debugInfo: allResults[0]?.debugInfo,
				},
			};
		},
	});

	pi.registerTool({
		name: "code_search",
		label: "Code Search",
		description:
			"Search for code examples, documentation, and API references. " +
			"Uses Exa's code search when EXA_API_KEY is set, otherwise falls back to web_search. " +
			"Returns relevant code snippets and docs from GitHub, Stack Overflow, and official documentation. " +
			"Use for any programming question — API usage, library examples, debugging help.",
		promptSnippet: "Use for programming/API/library questions to retrieve concrete examples and docs.",
		parameters: CodeSearchParams,
		async execute(_toolCallId, params) {
			const cfg = loadConfig();
			const maxResults = (params.maxResults as number) ?? 10;
			if (!params.query) {
				return toolError("No query provided.");
			}
			const { providers } = getActiveConfig(cfg);
			const hasExa = providers.some(p => p.id === "exa");

			if (hasExa) {
				try {
					const r = await exaProvider.search(params.query as string, maxResults, cfg);
					let output = "";
					if (r.answer) output += `${r.answer}\n\n`;
					if (r.results.length) output += "**Code Sources:**\n";
					for (let i = 0; i < r.results.length; i++) {
						const s = r.results[i];
						output += `${i + 1}. ${s.title}\n   ${s.url}\n`;
						if (s.snippet) output += `   \`\`\`\n   ${s.snippet.substring(0, 500)}\n   \`\`\`\n`;
					}
					const responseId = cacheKey("codesearch", params.query as string);
					storeCache(responseId, { type: "codesearch", query: params.query, results: r.results, timestamp: Date.now() });
					return {
						content: [{ type: "text" as const, text: output }],
						details: { query: params.query, resultCount: r.results.length, provider: "exa", responseId },
					};
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return toolError(`Code search failed: ${msg}`);
				}
			}

			// Fallback: web_search with code-focused query
			const codeQuery = `${params.query} code examples documentation GitHub Stack Overflow official docs`;
			const r = await performSearch(codeQuery, maxResults, undefined, undefined, undefined, cfg);
			let output = r.answer ? `${r.answer}\n\n` : "";
			if (r.results.length) output += "**Sources:**\n";
			for (let i = 0; i < r.results.length; i++) {
				const s = r.results[i];
				output += `${i + 1}. ${s.title}\n   ${s.url}\n`;
				if (s.snippet) output += `   ${s.snippet}\n`;
			}
			return {
				content: [{ type: "text" as const, text: output }],
				details: { query: params.query, resultCount: r.results.length, provider: r.provider, fallback: true },
			};
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			"Fetch URL(s) and extract readable content as markdown/text from HTML pages. " +
			"Content is cached locally and can be retrieved with get_search_content.",
		promptSnippet: "Use to extract readable content from URL(s).",
		parameters: FetchContentParams,
		async execute(_toolCallId, params) {
			const urls = params.urls?.length ? params.urls : (params.url ? [params.url] : []);
			if (!urls.length) {
				return { content: [{ type: "text" as const, text: "Error: No URL provided." }], details: { error: "No URL provided" }, isError: true };
			}

			const results = await Promise.all(urls.map(u => fetchUrlContent(u)));
			// Store with a deterministic URL-based key so get_search_content can find it
			for (let i = 0; i < results.length; i++) {
				const urlKey = urlToCacheKey(urls[i]);
				storeCache(`fetch_${urlKey}`, { type: "fetch", urls: [results[i]], url: urls[i], timestamp: Date.now() });
			}
			// Also store multi-URL batch under a combined key
			const combinedKey = cacheKey("fetch", urls.join("|"));
			storeCache(combinedKey, { type: "fetch", urls: results, timestamp: Date.now() });

			if (urls.length === 1) {
				const r = results[0];
				if (r.error) {
					return { content: [{ type: "text" as const, text: `Error: ${r.error}` }], details: { error: r.error, url: urls[0] }, isError: true };
				}
				const truncated = r.content.length > 30000;
				const output = truncated ? r.content.substring(0, 30000) + "\n\n[Content truncated...]" : r.content;
				const urlKey = `fetch_${urlToCacheKey(urls[0])}`;
				return {
					content: [{ type: "text" as const, text: `# ${r.title}\n\n${output}\n\n[Cached as: ${urlKey}]` }],
					details: { url: urls[0], title: r.title, chars: r.content.length, truncated, responseId: urlKey },
				};
			}

			// Multiple URLs
			const responseId = combinedKey;
			let output = `# Fetched ${urls.length} URLs\n\n`;
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				output += `## [${i}] ${r.title}\nURL: ${urls[i]}\n`;
				if (r.error) {
					output += `Error: ${r.error}\n\n`;
				} else {
					const truncated = r.content.length > 10000;
					output += truncated ? r.content.substring(0, 10000) + "\n[truncated]\n\n" : r.content + "\n\n";
				}
			}

			return {
				content: [{ type: "text" as const, text: output }],
				details: { urls, urlCount: urls.length, successful: results.filter(r => !r.error).length, responseId },
			};
		},
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Retrieve full content from a previous web_search, code_search, or fetch_content call using its responseId or URL.",
		promptSnippet: "Use after web_search/fetch_content when full stored content is needed via responseId or URL.",
		parameters: GetSearchContentParams,
		async execute(_toolCallId, params) {
			let data: Record<string, unknown> | null = null;

			if (params.responseId) {
				data = loadCache(params.responseId);
			}
			if (!data && params.url) {
				const urlKey = `fetch_${urlToCacheKey(params.url)}`;
				data = loadCache(urlKey);
			}

			if (!data) {
				return {
					content: [{ type: "text" as const, text: "No cached content found. Run web_search or fetch_content first, then pass the URL to get_search_content." }],
					details: { error: "Not found" },
					isError: true,
				};
			}

			if (data.type === "search") {
				const queries = data.queries as Array<{ query: string; answer: string; results: Array<{ title: string; url: string; snippet: string }> }>;
				let output = "";
				for (const q of queries) {
					output += `## Query: "${q.query}"\n\n`;
					if (q.answer) output += `${q.answer}\n\n`;
					for (const r of q.results) {
						output += `### ${r.title}\n${r.url}\n\n`;
					}
				}
				return { content: [{ type: "text" as const, text: output }], details: { type: "search", queryCount: queries.length } };
			}

			if (data.type === "fetch") {
				const urls = data.urls as Array<{ title: string; content: string; error?: string }>;
				let output = "";
				for (const u of urls) {
					output += `# ${u.title}\n\n`;
					if (u.error) output += `Error: ${u.error}\n`;
					else output += u.content;
					output += "\n\n";
				}
				return { content: [{ type: "text" as const, text: output.substring(0, 50000) }], details: { type: "fetch", urlCount: urls.length } };
			}

			if (data.type === "codesearch") {
				const results = data.results as Array<{ title: string; url: string; snippet: string }>;
				let output = "";
				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					output += `${i + 1}. ${r.title}\n   ${r.url}\n`;
					if (r.snippet) output += `   ${r.snippet}\n`;
					output += "\n";
				}
				return { content: [{ type: "text" as const, text: output }], details: { type: "codesearch", resultCount: results.length } };
			}

			return { content: [{ type: "text" as const, text: "Unknown cache type." }], details: { error: "Unknown type" }, isError: true };
		},
	});

	// =======================================================================
	// COMMANDS
	// =======================================================================

	pi.registerCommand("browser", {
		description: "Browser status, onboarding wizard, and usage help",
		handler: async (_args, ctx) => {
			const cfg = loadConfig();
			const { providers, active } = getActiveConfig(cfg);

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
				active ? `Active Search Provider: ${active.id} (${active.label})` : "Active Search Provider: NONE",
				`Configured Providers: ${providers.length > 0 ? providers.map(p => p.id).join(", ") : "none"}`,
				browserState.supervised && browserState.sessionDir ? `Screenshot dir: ${browserState.sessionDir}` : "",
			].filter(Boolean).join("\n");
			ctx.ui.notify(status, "info");

			// ── Onboarding prompt if no providers configured ──
			if (providers.length === 0) {
				ctx.ui.notify("", "info");
				ctx.ui.notify("⚠ No search providers configured. web_search and code_search are disabled.", "warning");
				ctx.ui.notify("", "info");

				const choice = await ctx.ui.select(
					"Would you like to configure a search provider?",
					[
						{ value: "brave",       label: "Brave Search — FREE (2,000 queries/mo)",  description: "Best free option. Sign up at brave.com/search/api/" },
						{ value: "tavily",      label: "Tavily — FREE (1,000 queries/mo)",        description: "Designed for AI agents. Sign up at app.tavily.com" },
						{ value: "exa",         label: "Exa — FREE tier (2,500 queries/mo)",      description: "Sign up at exa.ai" },
						{ value: "gemini",      label: "Google Gemini — free tier",               description: "Get key at aistudio.google.com/app/apikey" },
						{ value: "perplexity",  label: "Perplexity AI — paid",                    description: "Get key at perplexity.ai/settings/api" },
						{ value: "skip",        label: "Skip — configure later",                  description: "You can run /browser again anytime" },
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
					ctx.ui.notify("Skipped. Run /browser anytime to configure a provider.", "info");
				}
				return;
			}

			// ── Management menu (at least one provider configured) ──
			// BUG-6 fix: headless and supervised are now offered as selectable options
			const choice = await ctx.ui.select(
				`${active ? `Active: ${active.label}` : "No active provider"} · ${providers.length} configured · Options:`,
				[
					{ value: "switch",     label: "Switch active provider",                                            description: "Change which provider is used for web_search" },
					{ value: "add",        label: "Add another provider",                                              description: "Configure an additional search provider" },
					{ value: "remove",     label: "Remove a provider key",                                             description: "Clear a provider's key from settings.json" },
					{ value: "headless",   label: `Headless: ${browserState.headless} → ${!browserState.headless}`,   description: "Toggle visible/invisible browser. Run /reload to apply." },
					{ value: "supervised", label: `Supervised: ${browserState.supervised} → ${!browserState.supervised}`, description: "Auto-screenshot after each browser action." },
					{ value: "done",       label: "Done — status only",                                                description: "Exit wizard" },
				],
			);

			switch (choice) {
				case "headless": {
					// BUG-3 fix: patchExtConfig writes headless; getHeadless() now reads it
					patchExtConfig({ headless: !browserState.headless });
					ctx.ui.notify(`Headless set to ${!browserState.headless}. Run /reload to apply.`, "info");
					break;
				}
				case "supervised": {
					patchExtConfig({ supervised: !browserState.supervised });
					ctx.ui.notify(`Supervised mode ${!browserState.supervised ? "ON" : "OFF"}. Run /reload to apply.`, "info");
					break;
				}
				case "switch": {
					const newProvider = await ctx.ui.select("Switch active provider to:", providers.map(p => ({
						value: p.id, label: p.label, description: p.freeTier !== "—" ? `Free: ${p.freeTier}` : "Paid",
					})));
					if (newProvider) {
						patchExtConfig({ activeProvider: newProvider as ProviderId });
						ctx.ui.notify(`Active provider switched to ${PROVIDER_REGISTRY.find(p => p.id === newProvider)?.label}. Run /reload to apply.`, "info");
					}
					break;
				}
				case "add": {
					const unconfigured = PROVIDER_REGISTRY.filter(p => !providers.some(c => c.id === p.id));
					if (!unconfigured.length) {
						ctx.ui.notify("All providers are already configured.", "info");
						break;
					}
					const provider = await ctx.ui.select("Add provider:", unconfigured.map(p => ({
						value: p.id, label: p.label, description: p.freeTier !== "—" ? `Free: ${p.freeTier}` : "Paid",
					})));
					if (provider) {
						const def = PROVIDER_REGISTRY.find(p => p.id === provider)!;
						ctx.ui.notify(`To add ${def.label}:`, "info");
						ctx.ui.notify(`1. Get a key: ${def.signupUrl}`, "info");
						ctx.ui.notify(`   Shell:        export ${def.envKey}="your-key-here"`, "info");
						ctx.ui.notify(`   Pi settings:  ~/.pi/agent/settings.json → { "browserExt": { "${def.envKey}": "..." } }`, "info");
						ctx.ui.notify(`3. Run /reload to activate.`, "info");
					}
					break;
				}
				case "remove": {
					const toRemove = await ctx.ui.select("Remove provider:", providers.map(p => ({
						value: p.id, label: p.label,
					})));
					if (toRemove) {
						const def = PROVIDER_REGISTRY.find(p => p.id === toRemove)!;
						const remaining = providers.filter(p => p.id !== toRemove);
						// Build patch: remove the key and update activeProvider if needed
						const patch: Partial<ExtConfig> = { [def.envKey]: undefined } as Partial<ExtConfig>;
						if (cfg.ext.activeProvider === toRemove) {
							patch.activeProvider = remaining[0]?.id;
						}
						patchExtConfig(patch);
						ctx.ui.notify(`${def.label} removed. Run /reload to apply.`, "info");
					}
					break;
				}
				// "done" falls through with no action — correct
			}
		},
	});

	pi.registerCommand("web-switch", {
		description: "Quickly switch the active search provider",
		handler: async (_args, ctx) => {
			const cfg = loadConfig();
			const { providers, active } = getActiveConfig(cfg);

			if (!providers.length) {
				ctx.ui.notify("No providers configured. Run /browser for setup.", "warning");
				return;
			}
			if (providers.length === 1) {
				ctx.ui.notify(`Only one provider configured: ${providers[0].label}. Run /browser to add more.`, "info");
				return;
			}

			ctx.ui.notify(`Current: ${active?.label ?? "none"} · ${providers.length} configured`, "info");

			const newProvider = await ctx.ui.select("Switch to:", providers.map(p => ({
				value: p.id, label: p.label, description: p.id === active?.id ? "(current)" : "",
			})));

			if (newProvider && newProvider !== active?.id) {
				patchExtConfig({ activeProvider: newProvider as ProviderId });
				ctx.ui.notify(`Switched to ${PROVIDER_REGISTRY.find(p => p.id === newProvider)?.label}. Run /reload to activate.`, "info");
			} else if (newProvider === active?.id) {
				ctx.ui.notify("No change — same provider selected.", "info");
			}
		},
	});

	// =======================================================================
	// LIFECYCLE
	// =======================================================================

	pi.on("session_start", async (_event, ctx) => {
		const { active } = getActiveConfig(config);
		const suppress = config.ext.suppressStartupMessage === true;

		if (!suppress) {
			const supervisedOn = browserState.supervised;
			const screenshotPath = join(homedir(), "Pictures", "pi-web", "sessions");

			if (supervisedOn) {
				ctx.ui.notify(
					`[pi-web] Supervised mode: ON\n` +
					`  Screenshots saved to: ${screenshotPath}\n` +
					`  To toggle: set browserExt.supervised = true/false in ~/.pi/agent/settings.json\n` +
					`             — or just ask me to turn it on or off.\n` +
					`  To hide this message: set browserExt.suppressStartupMessage = true\n` +
					`                        — or just ask me to hide it.`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`[pi-web] Supervised mode: OFF\n` +
					`  To enable automatic screenshots: set browserExt.supervised = true\n` +
					`                                   — or just ask me to turn it on.\n` +
					`  To hide this message: set browserExt.suppressStartupMessage = true\n` +
					`                        — or just ask me to hide it.`,
					"info",
				);
			}
		}

		if (!active) {
			ctx.ui.notify(
				"⚠ No search key configured. web_search and code_search are disabled.\n" +
				"Run /browser for the setup wizard (Brave Search = free, 2,000 queries/mo).",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		await closeBrowser(browserState);
	});
}
