# Pipeline Scoreboard Schema

The pipeline scoreboard provides an at-a-glance status view of project gauges, showing PASS/WAIT/FAIL states with evidence and as-of timestamps.

## Schema version

Array form (canonical): `snapshot.json` contains an array of gauge objects.

## Status enum

Only three values allowed:
- `PASS` — requirement met
- `WAIT` — pending or in progress
- `FAIL` — blocked or failing

**Important**: Open PR ≠ PASS unless a gauge rule explicitly says so.

## Snapshot structure

```json
{
  "board": "project-board-id",
  "as_of": "2026-09-29 11:22 PDT",
  "repos": {
    "main_repo": "org/repo-name"
  },
  "tips": {
    "main": "abc123def4",
    "staging": "def456ghi7",
    "staging_ahead_of_main": 42
  },
  "gauges": [
    {
      "key": "unique_gauge_key",
      "label": "Human-readable gauge name",
      "status": "PASS | WAIT | FAIL",
      "evidence": "https://github.com/org/repo/pull/123",
      "detail": "Optional context or reason"
    }
  ],
  "score": {
    "PASS": 4,
    "WAIT": 2,
    "FAIL": 1
  },
  "open_prs": [
    {
      "number": 123,
      "title": "PR title",
      "isDraft": false,
      "url": "https://github.com/org/repo/pull/123"
    }
  ],
  "top_moves": [
    "Owner: action description with next step.",
    "Owner: another concrete action."
  ],
  "data_gaps": [
    "Description of any missing or unverified data"
  ]
}
```

## Field descriptions

### Required fields

- **`board`** (string): Project board identifier. Scoped to this project; determines theming.
- **`as_of`** (string): Timestamp when snapshot was generated, in local time with timezone.
- **`gauges`** (array): Array of gauge objects. Each gauge must have:
  - **`key`** (string): Stable unique identifier for this gauge (project-local, lowercase with underscores).
  - **`label`** (string): Human-readable gauge name displayed in UI.
  - **`status`** (string): One of `PASS`, `WAIT`, or `FAIL`.
  - **`evidence`** (string): URL, file path, or short proof text showing why this status was assigned.
- **`score`** (object): Count of gauges in each status (`PASS`, `WAIT`, `FAIL`). Must sum to total gauges.

### Optional fields

- **`repos`** (object): Repository references relevant to this board.
- **`tips`** (object): Git tip information (SHAs, branch comparisons).
- **`releases`** (object): Release/version tracking.
- **`detail`** (string, on gauge): Additional context for the gauge status.
- **`source`** (string, on gauge): Where this gauge status was confirmed (e.g., "desk-confirmed").
- **`open_prs`** (array): List of relevant pull requests.
- **`top_moves`** (array): Ordered next actions (3-5 recommended).
- **`data_gaps`** (array): Known limitations or unverified data in this snapshot.
- **`changed_since_prior`** (array): Gauges that changed status since last snapshot.
- **`prior_as_of`** (string): Timestamp of previous snapshot for comparison.

## Theming

Project theming is configured in `hub.config.js`:

```javascript
pipelineScoreboard: {
  enabled: true,
  board: "project-board-id",         // matches snapshot.json "board"
  snapshotPath: "snapshot.json",     // relative to site/
  brandColor: "#c2410c",             // gauge accent color (optional)
  brandColorDim: "rgba(194, 65, 12, 0.08)", // gauge background (optional)
}
```

If omitted, scoreboard uses site accent color from CSS variables.

## Example snapshots

See `site/snapshot.json` for a working example with typical gauge patterns.

## Export formats

The snapshot can be exported to shareable formats:

### HTML export

A standalone HTML file with embedded styles, suitable for:
- Email distribution
- Archive/record keeping
- Offline viewing

### PNG export

For skills and automation, export HTML then capture to PNG:

```bash
# Using puppeteer or similar
node scripts/snapshot-to-png.js snapshot.json output.png
```

See `scripts/export-snapshot.md` for export tooling documentation.

## Usage rules

1. Status must reflect current state, not aspirational goals
2. Open PR ≠ PASS unless gauge rules explicitly allow it
3. Evidence must be specific (URLs, paths, commit SHAs) not vague
4. Update `as_of` timestamp on every snapshot refresh
5. Keep gauge keys stable across snapshots for diff tracking
6. `top_moves` should be concrete actions with clear owners

## Migration from BTF map form

Legacy BTF format used an object map for gauges:

```json
"gauges": {
  "gauge_key": "PASS"
}
```

Migrate to array form for richer metadata:

```json
"gauges": [
  {
    "key": "gauge_key",
    "label": "Gauge Label",
    "status": "PASS",
    "evidence": "..."
  }
]
```

Array form is canonical; map form may be deprecated in future versions.
