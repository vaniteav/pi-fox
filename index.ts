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
 *   /search        — Search provider management (hub + /search <id> quick switch)
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
 *   First configured key becomes active. Use /search to manage providers at runtime.
 *
 * Usage:
 *   pi -e ~/.pi/agent/extensions/pi-fox/index.ts
 *   /browser    — first-run onboarding wizard
 *   /search     — search provider management
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve as resolvePath, sep as pathSep } from "node:path";
import { homedir } from "node:os";
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
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
	/**
	 * Custom-provider transforms are arbitrary JS compiled with new Function(). Modeled on
	 * VS Code Workspace Trust, that code stays inert unless the user EXPLICITLY opts in by
	 * setting this to literal true — so a config imported/synced from an untrusted source
	 * cannot achieve code execution on its own.
	 */
	trustCustomProviders?: boolean;
	/**
	 * Optional allowlist of directory roots that browser_upload_file may read from. When set,
	 * any upload path resolving outside every root is rejected — preventing an agent from
	 * exfiltrating arbitrary local files (e.g. SSH keys) to a page. Unset = no restriction.
	 */
	allowedUploadRoots?: string[];
}

/** Settings snapshot — read once per tool call, passed everywhere. Zero extra disk reads. */
interface Config {
	raw: Record<string, unknown>;
	ext: ExtConfig;
}

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

interface ConsoleEntry {
	type: string;
	text: string;
	timestamp: number;
}

interface NetworkEntry {
	method: string;
	url: string;
	status: number | null;
	timestamp: number;
}

interface PendingDialogHandler {
	action: "accept" | "dismiss";
	promptText?: string;
}

interface CaptureState {
	consoleLogs: ConsoleEntry[];
	networkRequests: NetworkEntry[];
	pendingNetworkQueue: Array<{ req: import("playwright").Request; entry: NetworkEntry }>;
	pendingDialog: PendingDialogHandler | null;
	maxEntries: number;
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

// ── Wizard test capture ──

/** Stores the last response captured by fetchJsonCapturing. Module-level — wizard steps are sequential. */
let _lastCapturedRaw: unknown = null;

/**
 * Thin wrapper around fetchJson that records the raw response.
 * Used only during the custom provider wizard test step.
 * Never used in production search paths.
 */
async function fetchJsonCapturing<T>(
	url: string,
	options?: Parameters<typeof fetchJson>[1],
): Promise<T> {
	const result = await fetchJson<T>(url, options);
	_lastCapturedRaw = result;
	return result;
}

function getLastCapturedRaw(): unknown {
	const val = _lastCapturedRaw;
	_lastCapturedRaw = null;
	return val;
}

// ── Tool helpers ──

/** Standard tool failure path. Pi marks thrown tool errors as failed executions. */
function toolError(text: string): never {
	throw new Error(text);
}

/**
 * `ctx.ui.select` renders plain strings and returns the chosen string. This wraps
 * it for `{ value, label }` options: it shows the labels and returns the matching
 * value, so callers switch on stable ids instead of display text.
 */
export async function selectValue<T extends string>(
	ui: Pick<ExtensionContext["ui"], "select">,
	title: string,
	options: readonly { value: T; label: string }[],
): Promise<T | undefined> {
	const labels = options.map(o => o.label);
	// ponytail: labels are the only key ui.select returns (the chosen string, not an
	// index), so duplicate labels can't be disambiguated. Fail loud, not silently misroute.
	if (new Set(labels).size !== labels.length) {
		throw new Error(`selectValue: duplicate option labels in "${title}"`);
	}
	const choice = await ui.select(title, labels);
	return choice === undefined ? undefined : options.find(o => o.label === choice)?.value;
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
		const base = join(homedir(), "Pictures", "pi-fox", "sessions");
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
async function getPage(state: BrowserState, capture: CaptureState): Promise<import("playwright").Page> {
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
	state.context.on("page", (page) => attachPageCapture(page, capture));
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

export function attachPageCapture(
	page: import("playwright").Page,
	captureState: CaptureState
): void {
	page.on("console", (msg) => {
		captureState.consoleLogs.push({ type: msg.type(), text: msg.text(), timestamp: Date.now() });
		if (captureState.consoleLogs.length > captureState.maxEntries)
			captureState.consoleLogs.shift();
	});

	page.on("request", (req) => {
		const entry: NetworkEntry = { method: req.method(), url: req.url(), status: null, timestamp: Date.now() };
		captureState.networkRequests.push(entry);
		captureState.pendingNetworkQueue.push({ req, entry });
		if (captureState.networkRequests.length > captureState.maxEntries) {
			const evicted = captureState.networkRequests.shift()!;
			const idx = captureState.pendingNetworkQueue.findIndex(item => item.entry === evicted);
			if (idx !== -1) captureState.pendingNetworkQueue.splice(idx, 1);
		}
	});

	page.on("response", (res) => {
		const request = res.request();
		const idx = captureState.pendingNetworkQueue.findIndex(item => item.req === request);
		if (idx !== -1) {
			captureState.pendingNetworkQueue[idx].entry.status = res.status();
			captureState.pendingNetworkQueue.splice(idx, 1);
		}
	});

	page.on("dialog", async (dialog) => {
		const handler = captureState.pendingDialog;
		captureState.pendingDialog = null;
		try {
			if (handler?.action === "accept")
				await dialog.accept(handler.promptText);
			else
				await dialog.dismiss();
		} catch { /* page navigated or dialog already handled */ }
	});
}

export function filterConsoleLogs(
	logs: ConsoleEntry[],
	type: string | undefined,
	limit: number
): ConsoleEntry[] {
	const filtered = type && type !== "all" ? logs.filter(e => e.type === type) : logs;
	return filtered.slice(-limit);
}

export function filterNetworkRequests(
	requests: NetworkEntry[],
	urlContains?: string,
	method?: string
): NetworkEntry[] {
	return requests.filter(e =>
		(!urlContains || e.url.includes(urlContains)) &&
		(!method || e.method.toUpperCase() === method.toUpperCase())
	);
}

// ── Browser tool schemas ──

const NavigateParams = Type.Object({
	url: Type.String({ description: "URL to navigate to, e.g. https://example.com" }),
	waitUntil: Type.Optional(Type.String({ description: "When to consider navigation done: 'load', 'domcontentloaded', or 'networkidle'. Default: 'load'" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Default: 30000" })),
});

const ClickParams = Type.Object({
	selector: Type.Optional(Type.String({ description: "CSS selector or element role to click, e.g. 'button.login', 'text=Submit', 'css=#submit-btn'. Omit when clicking by x/y coordinates." })),
	x: Type.Optional(Type.Number({ description: "Viewport X coordinate to click. Provide with 'y' to click by position (e.g. from a screenshot) instead of a selector — needed under strict CSP where evaluate/selectors are unavailable." })),
	y: Type.Optional(Type.Number({ description: "Viewport Y coordinate to click. Provide with 'x'." })),
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
	let hash = 5381;
	for (let i = 0; i < url.length; i++) hash = ((hash << 5) + hash) ^ url.charCodeAt(i);
	const prefix = url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 80);
	return `${prefix}_${Math.abs(hash).toString(36)}`;
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
	"Run /search for the interactive setup wizard.";

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
/**
 * Custom-provider transform code (compiled with new Function) only runs when the user has
 * explicitly set browserExt.trustCustomProviders to literal true. No truthy coercion: an
 * imported config carrying `1` or `"true"` does not unlock execution.
 */
export function customProviderCodeAllowed(config: { ext: { trustCustomProviders?: boolean } }): boolean {
	return config.ext.trustCustomProviders === true;
}

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
			// Defense in depth: never compile/run transform code unless explicitly trusted.
			if (!customProviderCodeAllowed(config)) {
				throw new Error(
					`Custom provider "${cfg.label}" is disabled — it runs arbitrary code. ` +
					`Set browserExt.trustCustomProviders=true in settings.json to enable it.`,
				);
			}
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

/** Built-in providers. Custom providers from settings.json are appended at startup inside browserWebExtension(). */
let PROVIDER_REGISTRY: ProviderImpl[] = [
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

// ── SSRF guard ──
//
// fetch_content fetches caller-supplied URLs. Without a guard that is an SSRF primitive
// against loopback, RFC1918, link-local (incl. the 169.254.169.254 cloud-metadata endpoint),
// and other internal ranges. Defense mirrors `request-filtering-agent` / `ssrf-req-filter`
// and Node's own `net.BlockList`: reject non-http(s) schemes, resolve the host and reject if
// ANY resolved address is private, and re-validate every redirect hop.
//
// Residual: a DNS-rebind between our lookup and undici's own lookup (TOCTOU) is not fully
// closed without a pinning dispatcher; the resolve-all-addresses check makes it impractical
// for the common single-record rebind and blocks every static/redirect vector.

const SSRF_BLOCKLIST = new BlockList();
// IPv4 ranges fetch_content must never reach.
SSRF_BLOCKLIST.addSubnet("0.0.0.0", 8, "ipv4");        // "this host" / unspecified
SSRF_BLOCKLIST.addSubnet("10.0.0.0", 8, "ipv4");       // RFC1918 private
SSRF_BLOCKLIST.addSubnet("100.64.0.0", 10, "ipv4");    // CGNAT
SSRF_BLOCKLIST.addSubnet("127.0.0.0", 8, "ipv4");      // loopback
SSRF_BLOCKLIST.addSubnet("169.254.0.0", 16, "ipv4");   // link-local incl. cloud metadata
SSRF_BLOCKLIST.addSubnet("172.16.0.0", 12, "ipv4");    // RFC1918 private
SSRF_BLOCKLIST.addSubnet("192.168.0.0", 16, "ipv4");   // RFC1918 private
SSRF_BLOCKLIST.addSubnet("224.0.0.0", 4, "ipv4");      // multicast
SSRF_BLOCKLIST.addSubnet("240.0.0.0", 4, "ipv4");      // reserved incl. 255.255.255.255
// IPv6.
SSRF_BLOCKLIST.addAddress("::1", "ipv6");              // loopback
SSRF_BLOCKLIST.addAddress("::", "ipv6");               // unspecified
SSRF_BLOCKLIST.addSubnet("fc00::", 7, "ipv6");         // unique-local
SSRF_BLOCKLIST.addSubnet("fe80::", 10, "ipv6");        // link-local

/** True if an IP literal (v4 or v6) is in a range fetch_content must never reach. */
export function isBlockedIp(ip: string): boolean {
	const fam = isIP(ip);
	if (fam === 4) return SSRF_BLOCKLIST.check(ip, "ipv4");
	if (fam === 6) {
		// IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) must be re-checked against the v4 ranges.
		const mapped = ip.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
		if (mapped && isIP(mapped[1]) === 4) return SSRF_BLOCKLIST.check(mapped[1], "ipv4");
		return SSRF_BLOCKLIST.check(ip, "ipv6");
	}
	return false; // not an IP literal — hostnames are checked after DNS resolution
}

/** Validates scheme (http/https only) and, for literal-IP hosts, the IP. Pure/synchronous. */
export function validateFetchUrlScheme(rawUrl: string): { ok: boolean; reason?: string } {
	let u: URL;
	try { u = new URL(rawUrl); } catch { return { ok: false, reason: "unparseable URL" }; }
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		return { ok: false, reason: `disallowed scheme '${u.protocol}'` };
	}
	const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
	if (isIP(host) && isBlockedIp(host)) return { ok: false, reason: `blocked host IP ${host}` };
	return { ok: true };
}

const MAX_FETCH_REDIRECTS = 5;

/** Rejects if scheme is bad or the host resolves to any private address (SSRF). */
async function assertUrlFetchable(rawUrl: string): Promise<void> {
	const v = validateFetchUrlScheme(rawUrl);
	if (!v.ok) throw new Error(`Blocked URL (${v.reason})`);
	const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
	if (isIP(host)) return; // literal IP already validated by validateFetchUrlScheme
	let addrs: Array<{ address: string }>;
	try {
		addrs = await dnsLookup(host, { all: true });
	} catch {
		throw new Error(`Blocked URL (DNS resolution failed for '${host}')`);
	}
	for (const a of addrs) {
		if (isBlockedIp(a.address)) throw new Error(`Blocked URL ('${host}' resolves to private address ${a.address})`);
	}
}

/** fetch() with manual redirect following — every hop re-validated against the SSRF guard. */
async function safeFetch(url: string, init: RequestInit): Promise<Response> {
	let current = url;
	for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop++) {
		await assertUrlFetchable(current);
		const res = await fetch(current, { ...init, redirect: "manual" });
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("location");
			if (!loc) return res;
			current = new URL(loc, current).toString();
			continue;
		}
		return res;
	}
	throw new Error(`Blocked URL (exceeded ${MAX_FETCH_REDIRECTS} redirects)`);
}

/**
 * True if `filePath` resolves inside one of `roots`. Empty/undefined roots = unrestricted
 * (non-breaking default). Used to constrain browser_upload_file to approved directories.
 */
export function uploadPathAllowed(filePath: string, roots: string[] | undefined): boolean {
	if (!roots || roots.length === 0) return true;
	const resolved = resolvePath(filePath);
	return roots.some(root => {
		const r = resolvePath(root);
		if (resolved === r) return true;
		const withSep = r.endsWith(pathSep) ? r : r + pathSep;
		return resolved.startsWith(withSep);
	});
}

// ── Content fetching ──

/** Async URL content fetch — uses native fetch, no execFileSync, does not block event loop. */
async function fetchUrlContent(url: string): Promise<{ title: string; content: string; error?: string }> {
	try {
		const res = await safeFetch(url, {
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

	// Append any user-defined providers from settings.json → browserExt.customProviders.
	// Custom providers execute arbitrary transform code, so they are only registered when the
	// user has explicitly set browserExt.trustCustomProviders=true (Workspace-Trust model).
	const declaredCustom = config.ext.customProviders ?? [];
	const customProvidersTrusted = customProviderCodeAllowed(config);
	const skippedCustomProviders = customProvidersTrusted ? 0 : declaredCustom.length;
	if (declaredCustom.length > 0 && customProvidersTrusted) {
		PROVIDER_REGISTRY = [
			braveProvider, tavilyProvider, exaProvider, geminiProvider, perplexityProvider,
			...declaredCustom.map(buildCustomProviderImpl),
		];
	}

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

	// ── Capture state — peer of browserState, survives closeBrowser() ──
	const captureState: CaptureState = {
		consoleLogs: [],
		networkRequests: [],
		pendingNetworkQueue: [],
		pendingDialog: null,
		maxEntries: 500,
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
				const page = await getPage(browserState, captureState);
				const wait = (params.waitUntil as "load" | "domcontentloaded" | "networkidle") ?? "load";
				await page.goto(params.url, { waitUntil: wait, timeout: params.timeout ?? 30000 });
				const title = await page.title();
				return await withSupervisedScreenshot(browserState, "navigate", { url: page.url(), title }, async () => ({
					text: `Navigated to ${params.url}\nTitle: ${title}\nURL: ${page.url()}`,
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Navigation failed: ${msg}`);
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
			// delay: 80ms simulates human button-hold duration (pointerdown → pointerup).
			// Without this, Playwright fires pointerdown+pointerup atomically at ~1ms,
			// which fails event-timing challenges that check for plausible hold durations.
			const hasCoords = typeof params.x === "number" && typeof params.y === "number";
			try {
				const page = await getPage(browserState, captureState);
				if (hasCoords) {
					// Coordinate click — no selector resolution, so it works under strict CSP
					// and screenshot-driven flows. page.mouse.click dispatches trusted events.
					await page.mouse.click(params.x!, params.y!, { delay: 80 });
					return await withSupervisedScreenshot(browserState, "click", { x: params.x, y: params.y }, async () => ({
						text: `Clicked at (${params.x}, ${params.y})`,
					}));
				}
				if (!params.selector) return toolError("browser_click requires either 'selector' or both 'x' and 'y'.");
				await page.click(params.selector, { timeout: params.timeout ?? 10000, delay: 80 });
				return await withSupervisedScreenshot(browserState, "click", { selector: params.selector }, async () => ({
					text: `Clicked: ${params.selector}`,
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const target = hasCoords ? `(${params.x}, ${params.y})` : `"${params.selector}"`;
				return toolError(`Click failed on ${target}: ${msg}`);
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
				const page = await getPage(browserState, captureState);
				// Triple-click to select all, then pressSequentially to type.
				// page.fill("") and locator.clear() both fire deleteContentForward beforeinput.
				// page.type() can also emit a spurious delete in Firefox.
				// pressSequentially with a prior selection fires only insertText beforeinputs —
				// the browser replaces the selection implicitly, no separate delete event.
				await page.click(params.selector, { clickCount: 3, timeout: params.timeout ?? 10000 });
				await page.locator(params.selector).pressSequentially(params.text, { delay: params.delay ?? 0 });
				return await withSupervisedScreenshot(browserState, "type", { selector: params.selector, text: params.text }, async () => ({
					text: `Typed into ${params.selector}: "${params.text}"`,
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Type failed on "${params.selector}": ${msg}`);
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
				const page = await getPage(browserState, captureState);
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
				const page = await getPage(browserState, captureState);
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
						{ type: "image" as const, data: base64, mimeType: `image/${format}` },
					],
					details: { format, size: buffer.length, url: page.url(), selector: (params.selector as string) ?? null },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Screenshot failed: ${msg}`);
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
				const page = await getPage(browserState, captureState);
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
		async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
			try {
				const page = await getPage(browserState, captureState);
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
				return toolError(`Wait failed: ${msg}`);
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
		async execute(): Promise<AgentToolResult<Record<string, unknown>>> {
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
				return toolError(`Tab list failed: ${msg}`);
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
				await getPage(browserState, captureState);
				const newPage = await browserState.context!.newPage();
				try {
					if (params.url) await newPage.goto(params.url, { waitUntil: "load", timeout: 30000 });
					browserState.page = newPage;
					const idx = browserState.context!.pages().length - 1;
					return { content: [{ type: "text" as const, text: `Opened new tab [${idx}]${params.url ? `: ${params.url}` : ""}` }], details: { index: idx, url: params.url } };
				} catch (gotoErr) {
					await newPage.close().catch(() => {});
					throw gotoErr;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`New tab failed: ${msg}`);
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
		async execute(): Promise<AgentToolResult<Record<string, unknown>>> {
			try {
				const pages = browserState.context?.pages() ?? [];
				if (pages.length <= 1) {
					await closeBrowser(browserState);
					return { content: [{ type: "text" as const, text: "Closed the last tab. Browser session ended." }], details: {} };
				}
				if (!browserState.page) return toolError("No active page to close");
				const closing = browserState.page;
				const currentIdx = pages.indexOf(closing);
				// runBeforeUnload:true runs the page's unload sequence (pagehide/visibilitychange/
				// beforeunload) so lifecycle handlers fire — the default skips them. Wait for the
				// 'close' to settle before switching so handlers complete and the tab list is stable.
				const settled = closing.waitForEvent("close", { timeout: 3000 }).catch(() => {});
				await closing.close({ runBeforeUnload: true });
				await settled;
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
					return toolError(`Tab index ${params.index} out of range. ${pages.length} tabs open (0-${pages.length - 1})`);
				}
				browserState.page = pages[params.index];
				return { content: [{ type: "text" as const, text: `Switched to tab [${params.index}]: ${(await browserState.page?.title()) || "(loading)"} - ${browserState.page?.url()}` }], details: { index: params.index } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Tab select failed: ${msg}`);
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
				const page = await getPage(browserState, captureState);
				// SPA pushState navigations fire `popstate` WITHOUT a load event, so waitUntil:'load'
				// would hang and never observe them. Arm a popstate marker, go back at 'commit' level
				// (resolves once committed, no load wait), then give a same-document back a brief
				// window to dispatch popstate. A full-page back wipes the marker and the wait simply
				// times out harmlessly.
				await page.evaluate(() => {
					(window as Window & { __pifoxPopstate?: boolean }).__pifoxPopstate = false;
					window.addEventListener("popstate", () => {
						(window as Window & { __pifoxPopstate?: boolean }).__pifoxPopstate = true;
					}, { once: true });
				}).catch(() => {});
				await page.goBack({ waitUntil: "commit", timeout: 15000 });
				await page.waitForFunction(
					() => (window as Window & { __pifoxPopstate?: boolean }).__pifoxPopstate === true,
					{ timeout: 1000 },
				).catch(() => {});
				return { content: [{ type: "text" as const, text: `Went back → ${page.url()}` }], details: { url: page.url() } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Back failed: ${msg}`);
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
				const page = await getPage(browserState, captureState);
				await page.evaluate(() => {
					(window as Window & { __pifoxPopstate?: boolean }).__pifoxPopstate = false;
					window.addEventListener("popstate", () => {
						(window as Window & { __pifoxPopstate?: boolean }).__pifoxPopstate = true;
					}, { once: true });
				}).catch(() => {});
				await page.goForward({ waitUntil: "commit", timeout: 15000 });
				await page.waitForFunction(
					() => (window as Window & { __pifoxPopstate?: boolean }).__pifoxPopstate === true,
					{ timeout: 1000 },
				).catch(() => {});
				return { content: [{ type: "text" as const, text: `Went forward → ${page.url()}` }], details: { url: page.url() } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Forward failed: ${msg}`);
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
				const page = await getPage(browserState, captureState);
				await page.reload({ waitUntil: "load", timeout: 30000 });
				return { content: [{ type: "text" as const, text: `Reloaded: ${page.url()}` }], details: { url: page.url() } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Reload failed: ${msg}`);
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

	pi.registerTool({
		name: "browser_key",
		label: "Browser Key",
		description: "Press a keyboard key or key combination. Use for Enter, Tab, Escape, arrow keys, and shortcuts like Control+A.",
		promptSnippet: "Press a keyboard key like Enter, Tab, or a shortcut like Control+A",
		promptGuidelines: [
			"Key names follow Playwright's key name spec: 'Enter', 'Tab', 'Escape', 'ArrowDown', 'Control+A', etc.",
			"Use count to repeat the key press multiple times.",
			"Use modifiers to combine with Shift, Control, Alt, or Meta.",
		],
		parameters: Type.Object({
			key: Type.String({ description: "Key name or combination (e.g. 'Enter', 'Control+A', 'ArrowDown')" }),
			count: Type.Optional(Type.Number({ description: "Number of times to press the key, default 1" })),
			modifiers: Type.Optional(Type.Object({
				shiftKey: Type.Optional(Type.Boolean({ description: "Hold Shift" })),
				ctrlKey: Type.Optional(Type.Boolean({ description: "Hold Control" })),
				altKey: Type.Optional(Type.Boolean({ description: "Hold Alt" })),
				metaKey: Type.Optional(Type.Boolean({ description: "Hold Meta/Cmd" })),
			}, { description: "Modifier keys to hold while pressing the key" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const page = await getPage(browserState, captureState);
				const mods = params.modifiers ?? {};
				const parts: string[] = [];
				if (mods.shiftKey) parts.push("Shift");
				if (mods.ctrlKey) parts.push("Control");
				if (mods.altKey) parts.push("Alt");
				if (mods.metaKey) parts.push("Meta");
				parts.push(params.key);
				const keyCombo = parts.join("+");
				const times = Math.max(1, Math.min(Math.floor(params.count ?? 1), 100));
				for (let i = 0; i < times; i++) {
					await page.keyboard.press(keyCombo);
				}
				return await withSupervisedScreenshot(browserState, "browser_key", params, async () => ({
					text: `Pressed "${params.key}" × ${times}`,
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Key press failed: ${msg}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_upload_file",
		label: "Browser Upload File",
		description: "Set files on a file input element.",
		promptSnippet: "Upload files to a file input element",
		promptGuidelines: [
			"selector must target an <input type='file'> element.",
			"paths must be absolute paths on the local filesystem.",
			"Multiple files can be provided as an array.",
		],
		parameters: Type.Object({
			selector: Type.String({ description: "CSS selector of the <input type='file'> element" }),
			paths: Type.Array(Type.String(), { description: "Absolute local filesystem paths to upload" }),
		}),
		async execute(_toolCallId, params) {
			const roots = config.ext.allowedUploadRoots;
			if (roots && roots.length > 0) {
				// Resolve symlinks on BOTH sides before containment — a symlink inside an allowed
				// root must not be able to point outside it. realpathSync also collapses junctions.
				// Fail closed: an unresolvable target, or roots that don't resolve, blocks the upload.
				const realRoots = roots
					.map(r => { try { return realpathSync(r); } catch { return null; } })
					.filter((r): r is string => r !== null);
				const blocked = params.paths.filter(p => {
					let real: string;
					try { real = realpathSync(p); } catch { return true; }
					return realRoots.length === 0 || !uploadPathAllowed(real, realRoots);
				});
				if (blocked.length > 0) {
					return toolError(`Upload blocked — path(s) outside browserExt.allowedUploadRoots: ${blocked.join(", ")}`);
				}
			}
			try {
				const page = await getPage(browserState, captureState);
				await page.locator(params.selector).setInputFiles(params.paths);
				return await withSupervisedScreenshot(browserState, "browser_upload_file", params, async () => ({
					text: `Set ${params.paths.length} file(s) on "${params.selector}"`,
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Upload failed on "${params.selector}": ${msg}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_drag",
		label: "Browser Drag",
		description: "Drag an element and drop it onto another element.",
		promptSnippet: "Drag an element and drop it onto another element",
		promptGuidelines: [
			"Both source and target must be valid CSS selectors.",
			"Uses Playwright's dragAndDrop which fires pointerdown, drag, and drop events.",
		],
		parameters: Type.Object({
			source: Type.String({ description: "CSS selector of the element to drag" }),
			target: Type.String({ description: "CSS selector of the drop target" }),
		}),
		async execute(_toolCallId, params) {
			try {
				const page = await getPage(browserState, captureState);
				await page.dragAndDrop(params.source, params.target);
				return await withSupervisedScreenshot(browserState, "browser_drag", params, async () => ({
					text: `Dragged "${params.source}" onto "${params.target}"`,
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Drag failed: ${msg}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_hover",
		label: "Browser Hover",
		description: "Move the mouse cursor over an element to trigger hover effects, tooltips, or dropdown menus.",
		promptSnippet: "Hover the mouse over a page element",
		promptGuidelines: [
			"Use position to target a specific offset within the element's bounding box.",
		],
		parameters: Type.Object({
			selector: Type.String({ description: "CSS selector of element to hover" }),
			position: Type.Optional(Type.Object({
				x: Type.Number({ description: "X offset in pixels from element top-left" }),
				y: Type.Number({ description: "Y offset in pixels from element top-left" }),
			})),
		}),
		async execute(_toolCallId, params) {
			try {
				const page = await getPage(browserState, captureState);
				const loc = page.locator(params.selector);
				await loc.scrollIntoViewIfNeeded();
				if (params.position) {
					await loc.hover({ position: params.position });
				} else {
					// Hover at multiple positions to generate several pointermove events.
					// Single locator.hover() fires only one pointermove; dwell-detection
					// challenges require moveCount >= 3.
					// page.mouse.move() does NOT fire JS pointer events in Firefox — only
					// the high-level locator API does.
					const box = await loc.boundingBox();
					if (box && box.width > 10 && box.height > 10) {
						const j = Math.min(box.width, box.height) * 0.15;
						const w = box.width / 2;
						const h = box.height / 2;
						await loc.hover({ position: { x: w - j, y: h } });
						await loc.hover({ position: { x: w, y: h - j } });
						await loc.hover({ position: { x: w + j, y: h } });
						await loc.hover({ position: { x: w, y: h } });
					} else {
						await loc.hover();
					}
				}
				return await withSupervisedScreenshot(browserState, "browser_hover", params, async () => ({
					text: `Hovered over "${params.selector}"`,
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Hover failed on "${params.selector}": ${msg}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_scroll",
		label: "Browser Scroll",
		description: "Scroll the page or a specific element. Omit selector to scroll the page; omit deltas to scroll an element into view.",
		promptSnippet: "Scroll the page or an element into view",
		promptGuidelines: [
			"Use deltaY > 0 to scroll down, < 0 to scroll up.",
			"Provide selector without deltas to scroll an element into view.",
			"Provide selector with deltas to scroll within that element's scroll container.",
			"Omitting all arguments scrolls the page by zero pixels — pass deltaY or a selector to scroll meaningfully.",
		],
		parameters: Type.Object({
			selector: Type.Optional(Type.String({ description: "CSS selector of element to scroll within or into view" })),
			deltaX: Type.Optional(Type.Number({ description: "Horizontal scroll in pixels (negative = left)" })),
			deltaY: Type.Optional(Type.Number({ description: "Vertical scroll in pixels (negative = up)" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const page = await getPage(browserState, captureState);
				let resultText: string;
				if (params.selector && params.deltaX == null && params.deltaY == null) {
					await page.locator(params.selector).scrollIntoViewIfNeeded();
					resultText = `Scrolled "${params.selector}" into view`;
				} else if (params.selector && (params.deltaX != null || params.deltaY != null)) {
					// Position mouse via locator.hover() (Firefox-compatible), then fire wheel events.
					// page.mouse.move() does NOT fire JS events in Firefox; locator.hover() does and
					// also correctly positions the logical mouse so mouse.wheel() lands on the element.
					const loc = page.locator(params.selector);
					await loc.scrollIntoViewIfNeeded();
					await loc.hover();
					await page.mouse.wheel(params.deltaX ?? 0, params.deltaY ?? 0);
					resultText = `Scrolled within "${params.selector}" (deltaX=${params.deltaX ?? 0}, deltaY=${params.deltaY ?? 0})`;
				} else {
					await page.mouse.wheel(params.deltaX ?? 0, params.deltaY ?? 0);
					resultText = `Scrolled page (deltaX=${params.deltaX ?? 0}, deltaY=${params.deltaY ?? 0})`;
				}
				return await withSupervisedScreenshot(browserState, "browser_scroll", params, async () => ({
					text: resultText,
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Scroll failed: ${msg}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_console",
		label: "Browser Console",
		description: "Read captured browser console logs. Logs are collected automatically from the moment the browser launches.",
		promptSnippet: "Read browser console logs",
		promptGuidelines: [
			"Use type 'error' to check for JavaScript errors on the page.",
			"Set clear: true to reset the buffer after reading.",
			"Console logs accumulate across navigation — use clear: true to start fresh.",
		],
		parameters: Type.Object({
			type: Type.Optional(Type.String({ description: "'log'|'error'|'warning'|'info'|'all' — default all" })),
			limit: Type.Optional(Type.Number({ description: "Max entries to return, default 50" })),
			clear: Type.Optional(Type.Boolean({ description: "Clear buffer after reading" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const entries = filterConsoleLogs(captureState.consoleLogs, params.type, params.limit ?? 50);
				if (params.clear) captureState.consoleLogs = [];
				const consoleText = entries.length === 0
					? "No console logs captured."
					: `${entries.length} console log(s):\n${entries.map(e => `[${e.type.toUpperCase()}] ${e.text}`).join("\n")}`;
				return { content: [{ type: "text" as const, text: consoleText }], details: {} };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Console read failed: ${msg}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_network",
		label: "Browser Network",
		description: "Read captured network requests. Requests are collected automatically from the moment the browser launches.",
		promptSnippet: "Read captured network requests",
		promptGuidelines: [
			"Use urlContains to filter to a specific endpoint or domain.",
			"Status is null for requests that have not received a response.",
			"Set clear: true to reset the buffer after reading.",
		],
		parameters: Type.Object({
			urlContains: Type.Optional(Type.String({ description: "Filter to URLs containing this substring" })),
			method: Type.Optional(Type.String({ description: "Filter by HTTP method: 'GET', 'POST', etc." })),
			clear: Type.Optional(Type.Boolean({ description: "Clear buffer after reading" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const entries = filterNetworkRequests(captureState.networkRequests, params.urlContains, params.method);
				if (params.clear) {
				captureState.networkRequests = [];
				captureState.pendingNetworkQueue = [];
			}
				const networkText = entries.length === 0
					? "No network requests captured."
					: `${entries.length} request(s):\n${entries.map(e => `[${e.method}] ${e.url} → ${e.status ?? "pending"}`).join("\n")}`;
				return { content: [{ type: "text" as const, text: networkText }], details: {} };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Network read failed: ${msg}`);
			}
		},
	});

	pi.registerTool({
		name: "browser_dialog",
		label: "Browser Dialog",
		description: "Arm a handler for the next browser dialog (alert, confirm, or prompt). Call this BEFORE the action that triggers the dialog.",
		promptSnippet: "Arm a handler for the next browser dialog",
		promptGuidelines: [
			"CRITICAL: Call browser_dialog BEFORE the action that triggers the dialog, not after.",
			"Dialogs that fire without an armed handler are auto-dismissed.",
			"Use promptText to supply input for window.prompt() dialogs.",
		],
		parameters: Type.Object({
			action: StringEnum(["accept", "dismiss"] as const, {
				description: "Whether to accept or dismiss the dialog",
			}),
			promptText: Type.Optional(Type.String({ description: "Text to enter for window.prompt() dialogs" })),
		}),
		async execute(_toolCallId, params) {
			try {
				captureState.pendingDialog = { action: params.action, promptText: params.promptText };
				return { content: [{ type: "text" as const, text: `Dialog handler armed: will ${params.action} the next dialog.` }], details: {} };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return toolError(`Dialog arm failed: ${msg}`);
			}
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
			"Run /search for the setup wizard, or set a key via env var or settings.json.",
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
			let contentFetchId: string | null = null;
			if ((params.includeContent as boolean) && topUrls.length) {
				output += `---\nCaching content for ${topUrls.length} URLs in background...\n`;
				contentFetchId = cacheKey("fetch", topUrls.join("|"));
				Promise.all(topUrls.map(u => fetchUrlContent(u))).then(contents => {
					storeCache(contentFetchId!, { type: "fetch", urls: contents, timestamp: Date.now() });
				}).catch(() => { /* background errors ignored */ });
			}

			return {
				content: [{ type: "text" as const, text: output.trim() }],
				details: {
					queries,
					queryCount: queries.length,
					provider: allResults[0]?.provider ?? "none",
					responseId,
					contentFetchId,
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
		async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
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
		async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
			const urls = params.urls?.length ? params.urls : (params.url ? [params.url] : []);
			if (!urls.length) {
				return toolError("No URL provided.");
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
					return toolError(r.error);
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
		async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
			let data: Record<string, unknown> | null = null;

			if (params.responseId) {
				data = loadCache(params.responseId);
			}
			if (!data && params.url) {
				const urlKey = `fetch_${urlToCacheKey(params.url)}`;
				data = loadCache(urlKey);
			}

			if (!data) {
				return toolError("No cached content found. Run web_search or fetch_content first, then pass the URL to get_search_content.");
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

			return toolError("Unknown cache type.");
		},
	});

	// =======================================================================
	// COMMANDS
	// =======================================================================

	async function runProviderSwitch(
		ctx: ExtensionContext,
		providers: ProviderImpl[],
	): Promise<void> {
		const newProvider = await selectValue(
			ctx.ui,
			"Switch active provider to:",
			providers.map(p => ({
				value: p.id,
				label: p.label,
			})),
		);
		if (!newProvider) return;

		// Load current config for comparison
		const currentCfg = loadConfig();
		if (newProvider === currentCfg.ext.activeProvider) {
			ctx.ui.notify("Already using that provider.", "info");
			return;
		}

		patchExtConfig({ activeProvider: newProvider as ProviderId });
		ctx.ui.notify(
			`Active provider switched to ${PROVIDER_REGISTRY.find(p => p.id === newProvider)?.label}. Run /reload to apply.`,
			"info",
		);
	}

	async function runProviderAdd(
		ctx: ExtensionContext,
		providers: ProviderImpl[],
	): Promise<void> {
		const unconfigured = PROVIDER_REGISTRY.filter(p => !providers.some(c => c.id === p.id));
		if (!unconfigured.length) {
			ctx.ui.notify("All providers are already configured.", "info");
			return;
		}
		const provider = await selectValue(
			ctx.ui,
			"Add provider:",
			unconfigured.map(p => ({
				value: p.id,
				label: p.label,
			})),
		);
		if (provider) {
			const def = PROVIDER_REGISTRY.find(p => p.id === provider)!;
			ctx.ui.notify(`${def.label}${def.freeTier ? ` — ${def.freeTier}` : ""}\nGet a key: ${def.signupUrl}`, "info");
			const key = await ctx.ui.input(`Paste your ${def.envKey}:`, "your-api-key-here");
			if (key && key.trim()) {
				patchExtConfig({ [def.envKey]: key.trim() } as Partial<ExtConfig>);
				ctx.ui.notify(`✓ ${def.label} key saved. Run /reload to activate.`, "info");
			} else {
				ctx.ui.notify("No key entered.", "info");
			}
		}
	}

	async function runProviderRemove(
		ctx: ExtensionContext,
		cfg: Config,
		providers: ProviderImpl[],
	): Promise<void> {
		const toRemove = await selectValue(
			ctx.ui,
			"Remove provider:",
			providers.map(p => ({ value: p.id, label: p.label })),
		);
		if (toRemove) {
			const def = PROVIDER_REGISTRY.find(p => p.id === toRemove)!;
			const remaining = providers.filter(p => p.id !== toRemove);
			const patch: Partial<ExtConfig> = { [def.envKey]: undefined } as Partial<ExtConfig>;
			if (cfg.ext.activeProvider === toRemove) {
				patch.activeProvider = remaining[0]?.id as ProviderId | undefined;
			}
			patchExtConfig(patch);
			ctx.ui.notify(`${def.label} removed. Run /reload to apply.`, "info");
		}
	}

	interface ProviderMeta {
		id: string;
		label: string;
		envKey: string;
		freeTier: string;
		signupUrl: string;
		apiKey: string;
	}

	async function runCollectProviderMeta(ctx: Parameters<typeof runProviderSwitch>[0]): Promise<ProviderMeta | null> {
		ctx.ui.notify("── Step 1 of 3: Provider details ──", "info");
		ctx.ui.notify(
			"You will be asked to select from options for each field.\n" +
			"For free-text values (name, URL, key), pick the matching option and enter your value when prompted.",
			"info",
		);

		const label = await selectValue(ctx.ui, "Provider display name — pick the closest match or 'Other' to type:", [
			{ value: "SerpAPI", label: "SerpAPI" },
			{ value: "Bing Web Search", label: "Bing Web Search" },
			{ value: "You.com", label: "You.com" },
			{ value: "Kagi", label: "Kagi" },
			{ value: "custom", label: "Other — I'll type it" },
		]);
		if (!label) return null;

		const id = (label === "custom" ? "custom" : label.toLowerCase().replace(/[^a-z0-9]/g, "-"));
		const envKey = (label === "custom" ? "CUSTOM_SEARCH_KEY" : label.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_KEY");

		ctx.ui.notify(`Provider ID will be: ${id}`, "info");
		ctx.ui.notify(`Env key name will be: ${envKey}`, "info");
		ctx.ui.notify(
			`Store your API key in settings.json now:\n` +
			`  Edit ~/.pi/agent/settings.json → add under "browserExt":\n` +
			`    "${envKey}": "your-key-here"`,
			"info",
		);

		const keyConfirm = await selectValue(ctx.ui, "Have you added your API key to settings.json?", [
			{ value: "yes", label: "Yes — key is saved" },
			{ value: "no", label: "No — cancel" },
		]);
		if (keyConfirm !== "yes") return null;

		const signupUrl = await selectValue(ctx.ui, "Signup / docs URL:", [
			{ value: "https://serpapi.com/", label: "SerpAPI — https://serpapi.com/" },
			{ value: "https://www.microsoft.com/en-us/bing/apis/bing-web-search-api", label: "Bing — microsoft.com" },
			{ value: "https://you.com/", label: "You.com — https://you.com/" },
			{ value: "https://kagi.com/", label: "Kagi — https://kagi.com/" },
			{ value: "unknown", label: "Other / unknown" },
		]);

		const freeTier = await selectValue(ctx.ui, "Free tier:", [
			{ value: "100/mo", label: "100 queries/mo" },
			{ value: "1,000/mo", label: "1,000 queries/mo" },
			{ value: "paid", label: "Paid only" },
			{ value: "free", label: "Free" },
		]);

		return {
			id,
			label: label === "custom" ? id : label,
			envKey,
			freeTier: freeTier ?? "—",
			signupUrl: signupUrl ?? "—",
			apiKey: "",
		};
	}

	const TRANSFORM_DRAFT_PATH = join(homedir(), ".pi", "web-cache", "custom-provider-draft.js");

	async function runCollectTransform(
		ctx: Parameters<typeof runProviderSwitch>[0],
		meta: ProviderMeta,
	): Promise<string | null> {
		ctx.ui.notify("── Step 2 of 3: Write the transform ──", "info");

		const template =
			`// Transform for ${meta.label}\n` +
			`// Signature: async function(query, n, apiKey, fetchJson)\n` +
			`// Return:    { answer: string, results: Array<{ title, url, snippet }> }\n` +
			`//\n` +
			`// 'fetchJson' is provided — use it for all HTTP calls (handles timeout + errors).\n` +
			`// Example fetchJson call:\n` +
			`//   const data = await fetchJson("https://api.example.com/search?q=" + encodeURIComponent(query), {\n` +
			`//     headers: { "Authorization": "Bearer " + apiKey }\n` +
			`//   });\n\n` +
			`async function(query, n, apiKey, fetchJson) {\n` +
			`  const data = await fetchJson("YOUR_ENDPOINT_URL?q=" + encodeURIComponent(query), {\n` +
			`    headers: { "Authorization": "Bearer " + apiKey }\n` +
			`  });\n` +
			`  return {\n` +
			`    answer: data.YOUR_ANSWER_FIELD || "",\n` +
			`    results: (data.YOUR_RESULTS_ARRAY || []).slice(0, n).map(r => ({\n` +
			`      title: r.YOUR_TITLE_FIELD,\n` +
			`      url:   r.YOUR_URL_FIELD,\n` +
			`      snippet: r.YOUR_SNIPPET_FIELD || ""\n` +
			`    }))\n` +
			`  };\n` +
			`}\n`;

		mkdirSync(join(homedir(), ".pi", "web-cache"), { recursive: true });
		writeFileSync(TRANSFORM_DRAFT_PATH, template, "utf-8");

		ctx.ui.notify(`Transform template written to:\n  ${TRANSFORM_DRAFT_PATH}`, "info");
		ctx.ui.notify("Edit it with any editor, or ask your pi agent:", "info");
		ctx.ui.notify(
			"─────────────────────────────────────────\n" +
			"Need help writing the transform? Ask your pi agent:\n\n" +
			`  "I'm adding a custom search provider called ${meta.label}.\n` +
			`   Here is the API documentation / endpoint: [paste docs or endpoint URL]\n\n` +
			`   Write a transform function with this exact signature:\n` +
			`     async function(query, n, apiKey, fetchJson)\n\n` +
			`   Where fetchJson(url, options) handles the HTTP call.\n` +
			`   It must return:\n` +
			`     { answer: string, results: Array<{ title: string, url: string, snippet: string }> }\n\n` +
			`   Save the completed function to:\n` +
			`     ${TRANSFORM_DRAFT_PATH}"\n` +
			"─────────────────────────────────────────",
			"info",
		);

		const action = await selectValue(ctx.ui, "When your transform is ready:", [
			{ value: "done", label: "Done — I've edited the file" },
			{ value: "cancel", label: "Cancel" },
		]);

		if (action !== "done") return null;

		try {
			return readFileSync(TRANSFORM_DRAFT_PATH, "utf-8").trim();
		} catch {
			ctx.ui.notify(`Could not read transform file at ${TRANSFORM_DRAFT_PATH}`, "warning");
			return null;
		}
	}

	async function runTestTransform(
		ctx: Parameters<typeof runProviderSwitch>[0],
		meta: ProviderMeta,
		transformSrc: string,
	): Promise<boolean> {
		ctx.ui.notify("── Step 3 of 3: Test ──", "info");
		ctx.ui.notify("Compiling transform...", "info");

		type TransformFn = (q: string, n: number, k: string, f: typeof fetchJson) => Promise<SearchResult>;
		let fn: TransformFn;
		try {
			fn = new Function(
				"query", "n", "apiKey", "fetchJson",
				`return (${transformSrc})(query, n, apiKey, fetchJson)`
			) as TransformFn;
		} catch (err) {
			ctx.ui.notify(
				`✗ Compile error — fix the syntax in your transform file:\n  ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			return false;
		}

		ctx.ui.notify("Syntax OK. Running live test search for \"test\"...", "info");

		const cfg = loadConfig();
		const apiKey = String(
			(cfg.ext as Record<string, unknown>)[meta.envKey] ||
			process.env[meta.envKey] || ""
		);

		if (!apiKey) {
			ctx.ui.notify(
				`✗ No API key found for ${meta.envKey}.\n` +
				`  Add it to ~/.pi/agent/settings.json → browserExt → "${meta.envKey}"`,
				"warning",
			);
			return false;
		}

		let result: SearchResult;
		try {
			result = await fn("test", 3, apiKey, fetchJsonCapturing as typeof fetchJson);
		} catch (err) {
			ctx.ui.notify(
				`✗ Runtime error:\n  ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			return false;
		}

		const raw = getLastCapturedRaw();
		ctx.ui.notify("RAW API RESPONSE:", "info");
		ctx.ui.notify(JSON.stringify(raw, null, 2).substring(0, 2000), "info");

		ctx.ui.notify("\nMAPPED OUTPUT:", "info");
		ctx.ui.notify(`answer: "${result.answer}"`, "info");
		if (result.results.length === 0) {
			ctx.ui.notify("✗ results: [] — empty! Check your results array field name.", "warning");
			return false;
		}
		result.results.forEach((r, i) => {
			ctx.ui.notify(
				`${i + 1}. ${r.title || "⚠ MISSING TITLE"}\n   ${r.url || "⚠ MISSING URL"}\n   ${r.snippet || "(no snippet)"}`,
				"info",
			);
		});

		const missingTitle = result.results.some(r => !r.title);
		const missingUrl = result.results.some(r => !r.url);
		if (missingTitle || missingUrl) {
			ctx.ui.notify(
				`✗ Some results are missing ${[missingTitle && "title", missingUrl && "url"].filter(Boolean).join(" and ")}.\n` +
				`  Check your field mappings in the transform.`,
				"warning",
			);
			return false;
		}

		ctx.ui.notify(`✓ ${result.results.length} results mapped successfully.`, "info");
		return true;
	}

	function saveCustomProvider(meta: ProviderMeta, transformSrc: string): void {
		const cfg = loadConfig();
		const existing = cfg.ext.customProviders ?? [];
		const newProvider: CustomProviderConfig = {
			id: meta.id,
			label: meta.label,
			envKey: meta.envKey,
			freeTier: meta.freeTier,
			signupUrl: meta.signupUrl,
			transform: transformSrc,
		};
		// Replace if ID already exists, otherwise append
		const updated = existing.some(p => p.id === meta.id)
			? existing.map(p => p.id === meta.id ? newProvider : p)
			: [...existing, newProvider];
		patchExtConfig({ customProviders: updated });
	}

	async function runCustomProviderWizard(
		ctx: Parameters<typeof runProviderSwitch>[0],
	): Promise<void> {
		ctx.ui.notify(
			"Custom Provider Wizard\n" +
			"─────────────────────\n" +
			"Add any search API without editing source code.\n" +
			"You will need: an API key, and a JS transform function.\n" +
			"The wizard will guide you through 3 steps.",
			"info",
		);

		const meta = await runCollectProviderMeta(ctx);
		if (!meta) {
			ctx.ui.notify("Wizard cancelled.", "info");
			return;
		}

		const transformSrc = await runCollectTransform(ctx, meta);
		if (!transformSrc) {
			ctx.ui.notify("Wizard cancelled.", "info");
			return;
		}

		const passed = await runTestTransform(ctx, meta, transformSrc);
		if (!passed) {
			const retry = await selectValue(ctx.ui, "Test failed. What would you like to do?", [
				{ value: "retry", label: "Edit transform and retry" },
				{ value: "save", label: "Save anyway" },
				{ value: "cancel", label: "Cancel" },
			]);
			if (retry === "retry") {
				const retryTransform = await runCollectTransform(ctx, meta);
				if (!retryTransform) return;
				const retryPassed = await runTestTransform(ctx, meta, retryTransform);
				if (retryPassed) {
					saveCustomProvider(meta, retryTransform);
				} else {
					ctx.ui.notify("Still failing. Saving anyway — run /search → Remove to undo.", "warning");
					saveCustomProvider(meta, retryTransform);
				}
			} else if (retry === "save") {
				saveCustomProvider(meta, transformSrc);
			} else {
				ctx.ui.notify("Cancelled — nothing saved.", "info");
				return;
			}
		} else {
			saveCustomProvider(meta, transformSrc);
		}

		ctx.ui.notify(
			`✓ ${meta.label} saved to settings.json.\n` +
			`Run /reload to activate it. It will appear in /search and the provider fallback chain.`,
			"info",
		);
	}

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
			const choice = await selectValue(
				ctx.ui,
				"Browser settings:",
				[
					{ value: "headless",   label: `Headless: ${browserState.headless} → ${!browserState.headless}` },
					{ value: "supervised", label: `Supervised: ${browserState.supervised} → ${!browserState.supervised}` },
					{ value: "done",       label: "Done" },
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

				const choice = await selectValue(
					ctx.ui,
					"Would you like to configure a search provider?",
					[
						{ value: "brave",      label: "Brave Search — FREE (2,000 queries/mo)" },
						{ value: "tavily",     label: "Tavily — FREE (1,000 queries/mo)" },
						{ value: "exa",        label: "Exa — FREE tier (2,500 queries/mo)" },
						{ value: "gemini",     label: "Google Gemini — free tier" },
						{ value: "perplexity", label: "Perplexity AI — paid" },
						{ value: "skip",       label: "Skip — configure later" },
					],
				);

				if (choice && choice !== "skip") {
					const def = PROVIDER_REGISTRY.find(p => p.id === choice);
					if (def) {
						ctx.ui.notify(`${def.label}${def.freeTier ? ` — ${def.freeTier}` : ""}\nGet a key: ${def.signupUrl}`, "info");
						const key = await ctx.ui.input(`Paste your ${def.envKey}:`, "your-api-key-here");
						if (key && key.trim()) {
							patchExtConfig({ [def.envKey]: key.trim(), activeProvider: def.id as ProviderId } as Partial<ExtConfig>);
							ctx.ui.notify(`✓ ${def.label} configured. Run /reload to activate.`, "info");
						} else {
							ctx.ui.notify("No key entered. Run /search anytime to configure a provider.", "info");
						}
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

			const choice = await selectValue(
				ctx.ui,
				`${active ? `Active: ${active.label}` : "No active provider"} · ${providers.length} configured · Options:`,
				[
					{ value: "switch",     label: "Switch active provider" },
					{ value: "add",        label: "Add a provider" },
					{ value: "add-custom", label: "Add custom provider" },
					{ value: "remove",     label: "Remove a provider key" },
					{ value: "done",       label: "Done" },
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

	// =======================================================================
	// LIFECYCLE
	// =======================================================================

	pi.on("session_start", async (_event, ctx) => {
		const { active } = getActiveConfig(config);
		const suppress = config.ext.suppressStartupMessage === true;

		if (!suppress) {
			const supervisedOn = browserState.supervised;
			const screenshotPath = join(homedir(), "Pictures", "pi-fox", "sessions");

			if (supervisedOn) {
				ctx.ui.notify(
					`[pi-fox] Supervised mode: ON\n` +
					`  Screenshots saved to: ${screenshotPath}\n` +
					`  To toggle: set browserExt.supervised = true/false in ~/.pi/agent/settings.json\n` +
					`             — or just ask me to turn it on or off.\n` +
					`  To hide this message: set browserExt.suppressStartupMessage = true\n` +
					`                        — or just ask me to hide it.`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`[pi-fox] Supervised mode: OFF\n` +
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
				"Run /search for the setup wizard (Brave Search = free, 2,000 queries/mo).",
				"warning",
			);
		}

		if (skippedCustomProviders > 0) {
			ctx.ui.notify(
				`⚠ ${skippedCustomProviders} custom search provider(s) not loaded — they execute custom code.\n` +
				"To enable: set browserExt.trustCustomProviders = true in ~/.pi/agent/settings.json, then /reload.",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		await closeBrowser(browserState);
	});
}
