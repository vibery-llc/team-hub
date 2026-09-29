# Pipeline scoreboard — canonical snapshot schema

**Locked 2026-09-29 (Charlie).** Hub live strip and skill PNG/PDF export read the **same** `snapshot.json` bytes.

Status enum: `PASS` | `WAIT` | `FAIL`

## Required fields

| Field | Type | Notes |
|---|---|---|
| `board` | string | Stable board id (`btf-pipeline`, `vibery-session-zero`, …) |
| `title` | string | Human title for HTML/PNG/PDF header |
| `as_of` | string | ISO-8601 or local PT (`2026-09-29 11:22 PDT`) |
| `score` | object **or** string | Prefer `{ "pass", "wait", "fail" }` (lowercase keys, ints). Scoreline string (`"4 pass · 2 wait · 0 fail"`) also OK. |
| `gauges` | **array** | Ordered list of `{ key, label, status, evidence }`. **Not** a key→status map. |

### Gauge object

| Field | Type | Notes |
|---|---|---|
| `key` | string | Stable snake_case id |
| `label` | string | Display label |
| `status` | string | `PASS` \| `WAIT` \| `FAIL` |
| `evidence` | string \| string[] | Link, path, or short proof |

## Optional fields

| Field | Type | Notes |
|---|---|---|
| `open_work` | array | `{ id, class?, title, state?, next? }` — PRs, tasks, or both |
| `drift` | object \| array \| string | Branches vs base, roster holes, calendar collisions |
| `top_moves` | array | Strings **or** `{ move, owner }` — 3–5 ordered next actions |
| `changed_since_prior` | array | `{ key, from, to, label? }` gauge flips |
| `prior_as_of` | string | Prior snapshot timestamp |
| `material_change` | boolean | Hint for quiet-if-unchanged |

Board-specific extras (`repos`, `tips`, `main`, `branches`, `data_gaps`, …) are allowed **alongside** the canonical fields. Do not replace `gauges` array with a map.

## Map → array migration (BTF desk)

**Wrong (legacy desk / hub stub):**
```json
"gauges": { "freeze": "PASS", "reachcon": "FAIL" }
```

**Right (canonical):**
```json
"gauges": [
  { "key": "freeze", "label": "Freeze gates on main", "status": "PASS", "evidence": "…" },
  { "key": "reachcon", "label": "ReachCon rename (BF-249)", "status": "FAIL", "evidence": "…" }
]
```

Migrated BTF example: `btf-migrated.snapshot.json` (originals under `/workspace/kf-desk-proof/pipeline-scoreboard/` and hub stub left untouched).

## Theme pack (shared HTML → PNG/PDF)

```json
{
  "board": "btf-pipeline",
  "title": "BTF Pipeline Scoreboard",
  "brand": {
    "primary": "#1f2328",
    "pass": "#1a7f37",
    "wait": "#9a6700",
    "fail": "#cf222e",
    "surface": "#ffffff",
    "bg": "#f6f8fa",
    "logo": null
  },
  "gauge_set": ["freeze", "justin_inv", "nick_inv", "toolswing", "reachcon", "beautiful_corner", "axe_gym"]
}
```

Hub UI and skill export must render from the same snapshot + theme; PNG/PDF are screenshots/prints of that HTML so bytes match the live board.

## Delivery

1. Write `snapshot.json` (canonical schema).
2. Render `index.html` from snapshot (+ theme).
3. PNG via Puppeteer screenshot — see `render-png.mjs` (source also at `/workspace/scoreboard-pilots/2026-09-29/render-png.mjs`).
4. PDF via same Chromium session: `page.pdf({ path, printBackground: true, preferCSSPageSize: true })` (no separate pipeline yet; add beside PNG in the render script when Design wires print CSS).
5. Quiet if gauges + material open_work unchanged since prior (`material_change: false` or empty `changed_since_prior`).

## Consumers

| Consumer | Path / note |
|---|---|
| Skill | `/home/box/agent-data/workflows/pipeline-scoreboard/SKILL.md` |
| Pilots (array ✓) | `/workspace/scoreboard-pilots/2026-09-29/{vibery-session-zero,compass-sunday-ops,cos-hanging-thread}/` |
| BTF desk (map — migrate) | `/workspace/kf-desk-proof/pipeline-scoreboard/snapshot.json` |
| Hub stub (map — KF Desk PR) | `/workspace/kf-hub-scoreboard-pr/site/btf-pipeline-scoreboard/` |

## Score key casing

Canonical: lowercase `pass` / `wait` / `fail`.  
Pilots and BTF desk currently emit uppercase `PASS` / `WAIT` / `FAIL`. Readers should accept both during converge; new writes use lowercase.
