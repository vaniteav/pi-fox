# pi-fox Benchmark Runner

Run all pi-chrome challenges and produce a scored report.

## Prerequisites

- pi-fox extension loaded
- pi-chrome test server running at `http://127.0.0.1:8765/`

## Tool name mapping

Recipe steps use `chrome_*` tool names. Map to pi-fox equivalents:

| Recipe tool | pi-fox tool |
|---|---|
| `chrome_click` | `browser_click` |
| `chrome_type` / `chrome_fill` | `browser_type` |
| `chrome_hover` | `browser_hover` |
| `chrome_scroll` | `browser_scroll` |
| `chrome_key` | `browser_key` |
| `chrome_drag` | `browser_drag` |
| `chrome_upload_file` | `browser_upload_file` |
| `chrome_evaluate` | `browser_evaluate` |
| `chrome_snapshot` | `browser_snapshot` |
| `chrome_screenshot` | `browser_screenshot` |
| `chrome_tab` | `browser_tab_new` / `browser_tab_select` |
| `chrome_list_console_messages` | `browser_console` |
| `chrome_list_network_requests` | `browser_network` |
| `chrome_wait_for` / `wait` | `browser_wait` |
| `chrome_back` / `chrome_go_back` | `browser_back` |
| `chrome_forward` / `chrome_go_forward` | `browser_forward` |
| `dialog` | `browser_dialog` (arm before triggering action) |

## Protocol

### 1. Verify server

Use `browser_navigate` to navigate to `http://127.0.0.1:8765/`. If the page fails to load, stop and report: "Test server not running. Start pi-chrome with `npm start` in its directory."

### 2. Load manifest

Read `benchmark/manifest.json`. Each challenge has:
- `id` — string slug (e.g. `"is-trusted-click"`)
- `file` — HTML path relative to server root (e.g. `"challenges/01-is-trusted-click.html"`)
- `goal` — what the challenge tests
- `gate` — `"core"` | `"conditional"` | `"quality"`
- `expected` — object with three keys: `synthetic`, `trusted`, `manual` — each `"PASS"`, `"FAIL"`, or `"CONDITIONAL"`
- `recipe` — ordered array of `{ tool, params }` steps to execute
- `verdictDelayMs` — optional extra wait before reading verdict (in ms)

### 3. Run each challenge

For each challenge in the manifest:

**a. Check expected.trusted**

If `challenge.expected.trusted === "CONDITIONAL"`, record `SKIP` immediately and move to the next challenge. These depend on browser/OS capabilities outside pi-fox's control.

**b. Navigate** to `http://127.0.0.1:8765/{challenge.file}`

**c. Execute the recipe** — follow each `{ tool, params }` step in order, mapping tool names using the table above. Pass through any params the recipe specifies, ignoring params that pi-fox tools don't support (e.g. `trusted: true` is a pi-chrome-only flag).

**d. Wait** — if the challenge has `verdictDelayMs`, wait that long after the last recipe step. Then poll `window.__verdict` via `browser_evaluate` every 100ms for up to 1500ms total.

**e. Compare verdict** — compare `window.__verdict` to `challenge.expected.trusted`:
- `window.__verdict === challenge.expected.trusted` → **PASS**
- `window.__verdict` is a different value → **FAIL** (record `window.__verdict` and `window.__reason` in note)
- `window.__verdict` is still undefined after polling → **UNKNOWN**

**f. Record** the result: id, goal, gate, verdict, note.

### 4. Write score card

After all challenges, write the score card to `benchmark/results/YYYY-MM-DD-HHmm.md`.

**Gate counting rules:**
- `core`: count PASS only. FAIL or UNKNOWN marks the gate broken.
- `conditional`: count PASS only. SKIP does not count as failure.
- `quality`: record all verdicts. None affect gate pass/fail status.

**TOTAL** sums all three gate pass counts and totals. A run is release-ready when CORE is 100% (zero FAIL or UNKNOWN). CONDITIONAL rate is computed excluding SKIPs from the denominator. QUALITY is informational only and never affects release readiness.

**Score card format:**

```
# pi-fox benchmark — {DATE}

## Gate Summary
CORE        (release blockers)   {bar}  {pass} / {total}
CONDITIONAL (capability)         {bar}  {pass} / {total}
QUALITY     (fingerprint)        {bar}  {pass} / {total}
──────────────────────────────────────────────────────
TOTAL                            {bar}  {pass} / {total}

## Per-Challenge Results
| id | Goal | Gate | Expected (trusted) | Verdict | Note |
|----|------|------|--------------------|---------|------|
{one row per challenge}
```

Progress bar: use █ for passed, ░ for not-passed, scaled to 14 characters.
