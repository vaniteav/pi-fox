# pi-fox Benchmark Runner

Run all pi-chrome challenges and produce a scored report.

## Prerequisites

- pi-fox extension loaded
- pi-chrome test server running at `http://127.0.0.1:8765/`

## Protocol

### 1. Verify server

Use `browser_navigate` to navigate to `http://127.0.0.1:8765/`. If the page fails to load, stop and report: "Test server not running. Start pi-chrome with `npm start` in its directory."

### 2. Load manifest

Read `benchmark/manifest.json`. This contains the challenges. Each challenge has:
- `id` — challenge number
- `name` — human-readable name
- `gate` — `"core"` | `"conditional"` | `"quality"`
- `expected` — `"synthetic"` | `"trusted"` | `"manual"`
- `category` — task category
- `task` — the instruction to follow

### 3. Run each challenge

For each challenge in the manifest:

**a. Navigate** to `http://127.0.0.1:8765/challenge/{id}`

**b. Execute the task** described in the challenge's `task` field using pi-fox browser tools.

**c. Read the verdict** using `browser_evaluate` with this expression:
```
({ verdict: window.__verdict, reason: window.__reason, events: window.__events })
```

Wait up to 1500ms by polling every 100ms if `verdict` is undefined — some verifiers run asynchronously after the action.

**d. Determine result** based on `expected` type:

- **`synthetic`**: Use `window.__verdict` as the result (`PASS`, `FAIL`, or `UNKNOWN` if still undefined after polling).
- **`trusted`**: Compare your response to the challenge's expected answer. Record `PASS` or `FAIL` with a one-sentence explanation of the comparison. If comparison is not possible (e.g. server error), record `FAIL` with the reason. Notes are required for all verdicts.
- **`manual`**: Record `MANUAL_REVIEW`. Describe what you did in the note field.
- **`SKIP`**: Use when a challenge is not applicable in the current environment (e.g. a tool the extension doesn't support). Only valid for `conditional`-gate challenges. Treated as neutral — does not count as a failure.

**e. Record** the result: id, name, gate, expected, verdict, note (reason or explanation).

### 4. Write score card

After all challenges, write the score card to `benchmark/results/YYYY-MM-DD-HHmm.md`.

**Gate counting rules:**
- `core` gate total = challenges where gate is "core". Count PASS only.
- `conditional` gate total = challenges where gate is "conditional". Count PASS only. SKIP and MANUAL_REVIEW do not count as failures.
- `quality` gate total = challenges where gate is "quality". Record all verdicts. None affect the gate pass/fail status.

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
| # | Name | Gate | Expected | Verdict | Note |
|---|------|------|----------|---------|------|
{one row per challenge}
```

Progress bar: use █ for passed, ░ for not-passed, scaled to 14 characters.

TOTAL sums all three gate pass counts and totals. All three gates must reach 100% for a release-ready benchmark run.
