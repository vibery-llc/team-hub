# Configured overview and guided setup — draft

This branch is for upstream review only. It does not migrate existing tenants, change authentication, or deploy anything. The overview and guided journal/map now share configuration and navigation. Maintainers still need to review the new-clone defaults before merge.

## Compatibility

The fictional example config explicitly enables `overview` and `onboarding`. An unanchored root/index visit redirects to overview.html only with `overview.enabled: true`. Existing configs with no block keep the dashboard as home. `index.html?view=dashboard` always opens the dashboard; existing index hashes bypass the redirect. `site/index.html`, setup reference anchors, Functions, authentication and deployment configuration are unchanged. The scoreboard shortcut appears only when enabled; the ticket shortcut requires a configured tracker.

## Overview configuration

`overview` owns `description`, `placesTitle`, `places` (label, description, detail, icon, links), `placesNote`, optional `referenceExample` (containers/objects and a separately labeled shared asset reference), `workTitle`, local `workPath`, tenant-defined `stages`, and `guidance` (title/items/links). See hub.config.js for a fictional example.

The work document has `example`, `checkedAt` (ISO timestamp), and `items` containing title, explicit status, summary, optional next/revision and sources (label/href). Examples are visibly labeled. Merges or passing checks never imply acceptance. Missing sources/timestamps remain explicit; impossible calendar dates are rejected. Unavailable data retains dashboard navigation and never becomes successful work. Fetches time out after eight seconds. Text uses textContent, links allow HTTP(S), and icons/data paths must be local.

## Guided setup configuration

`onboarding.enabled: true` plus a valid `id` and nonempty valid `steps` enables start.html and project-map.html. Both views share the same progression. Absent/disabled/invalid configuration shows setup and dashboard fallback links. No existing tenant is opted in by inference.

Configure `title`, `description`, `helperName`, positive integer `version`, and steps with stable unique `id`, `short`, `title`, `action`, `body`, `instructions` (plain-text array), `links` (label/href), `check`, `proof`, `reinforcement`, and optional `selectAgent`. IDs contain lowercase letters, digits and hyphens, starting with a letter/digit (maximum 64 characters). Configured copy is rendered literally, never as HTML. The helper is explicitly scripted; no chat integration is claimed.

Personal notes live only in `teamhub.quest.<id>.v<version>` in localStorage. Keep IDs stable when rewording a step; increment the version for an intentional reset. Stale/duplicate/unknown reported steps are pruned. Both views support hash navigation, browser Back, reload/resume, idempotent reporting, and inline-confirmed reset of only this key. Blocked storage falls back to visit-only state with an explanation. Existing agent choice remains shared with setup. These reports never verify access, builds, delivery status or human acceptance.

## Validation (2026-10-01)

85 Node tests pass across scripts and Functions, including overview and quest model/config regressions. Browser checks used the generic fictional configuration, separately from tenant QA:

- Absent/disabled/empty config, normal opt-in root routing, dashboard bypass and scoreboard links.
- HTTP failure, malformed/empty JSON, missing/invalid timestamp, missing tracker, and eight-second timeout.
- Alternate two-step configuration and helper name; HTML-like copy stays literal; blocked storage retains visit-only operation.
- Journal/map shared notes, repeated reporting, reload, Back, reset cancel/confirm, keyboard Enter on disclosures/actions, focus on the new heading after continuation/reset, and visible focus outlines.
- Overview, journal and map at 390px and 320px with no document overflow, including expanded journal instructions. The 320px area grid switches to one column.
- Light and dark visual review. Overview dark screenshots use a fixture that activates the existing dark CSS media rules without changing the OS theme. Journal dark uses its appearance control. Secondary text contrast was corrected on these new surfaces. This is a targeted keyboard/visual check, not a comprehensive screen-reader audit.

Screenshots are under `docs/screenshots/`. Run `python3 scripts/fixtures/overview-preview.py` for loopback-only fixtures at port 8104; `/fixture/<case>/overview.html` and `/fixture/<case>/start.html` expose the cases documented in that script. The fixture is never part of the deployed site.

No upstream merge, deploy, or global rollout is authorized by this draft.
