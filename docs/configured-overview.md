# Configured overview — draft groundwork

This branch is for upstream review only. It does not migrate existing tenants, change authentication or deploy anything. The newer guided-onboarding direction is not included here; it must be reconciled before this draft is ready to merge.

## Compatibility

The shipped fictional config opts into `overview.enabled: true`. On an unanchored root/index visit, hub.js redirects to overview.html only when that explicit flag is true. Existing tenant configs with no block keep the dashboard as their home page. `index.html?view=dashboard` always opens the dashboard; existing index section hashes also bypass the redirect. `site/index.html` and its pipelineScoreboard markup are unchanged. The overview shows an optional scoreboard link only when that existing feature is enabled.

## Configuration

`overview` owns `description`, `placesTitle`, `places` (label, description, detail, icon, links), `placesNote`, optional `referenceExample` (containers/objects and a separately labeled shared asset reference), `workTitle`, local `workPath`, tenant-defined `stages`, and `guidance` (title/items/links). See the complete fictional example in hub.config.js.

The work document has `example`, `checkedAt` (ISO timestamp), and `items` containing title, explicit status, summary, optional next/revision and sources (label/href). The sample is visibly marked fictional. No status is inferred from a merge or passing checks. Missing sources/timestamps stay explicit. Invalid/missing data shows an unavailable status and retains dashboard navigation. Work fetches time out after eight seconds. Text uses textContent; links are HTTP(S), with icons/data paths constrained to local URLs.

## Checks performed

76 tests pass across scripts and Functions, including 9 overview model/config tests. Browser-rendered desktop and 390px mobile captures in docs/screenshots/configured-overview-*.png. Mobile document width is 390px. Explicit dashboard navigation and browser Back checked. Index dashboard is unchanged against upstream main.

## Required before ready for review/merge

- Reconcile the newly approved guided-setup journal/map direction with this generic overview surface and configuration API.
- Complete browser fixtures for absent/disabled config, missing/malformed/empty work JSON, and scoreboard enabled/disabled.
- Finish dark-theme and keyboard/accessibility review for the upstream generic surface. KF tenant verification is separate and does not substitute for these checks.
- Confirm default navigation semantics for new clones with upstream maintainers.

No upstream merge or global rollout is authorized by this draft.
