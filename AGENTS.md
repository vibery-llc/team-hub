# Agent guidance

Follow `CONTRIBUTING.md` for product changes to this repository.

## Shared activity log

The activity log is optional and disabled by default. An agent must not enable
it, name its owner, or post to it without an explicit request from a human.

Before adding an update, confirm all three conditions:

1. `site/hub.config.js` has `activityLog.enabled: true`.
2. `activityLog.owner` names the human accountable for the log.
3. That human explicitly asked for the workstream update to be shared.

Use `node scripts/add-activity.mjs --help` and let the command write the entry.
Each entry is one concise outcome, milestone, decision, blocker, or next step,
plus an HTTPS link to the true project record. Review the diff before committing.

Never post private reasoning traces, messages, credentials, personal data, raw
customer data, raw logs, or secrets. The owner label is the minimum approved
attribution, not permission to include any other personal information. Humans
remain accountable for decisions and external actions; an activity entry never
records an agent as the decision-maker.

## Usage stats attribution

The hub always records anonymous aggregate usage counts (page opens, agent
launches) — that needs no opt-in and an agent doesn't need to do anything
about it. Per-person attribution is different: it names which teammate did
what, and turning it on is a tenant policy decision, not an agent's to make.

An agent must not set `usageStats.attribution.enabled` to `true` or name its
`owner` in `site/hub.config.js`. Only make that change after a human
explicitly asks for per-person attribution to be turned on.

## Feedback and pinned notes

`feedback.enabled` and `notes.enabled` are tenant opt-ins. An agent must not
turn them on.

Agents may file feedback, comment, and claim an open item. They may propose
a pinned-note update (`propose_note`). They must not pin a note, approve or
reject a proposal, or treat a pending proposal as the published note. Those
actions stay with a human in the hub.

## Unified comments

`comments.enabled` is a tenant opt-in. An agent must not turn it on or name
`comments.admins`. The API is 404 while the flag is off. There is no comments
UI yet.

Locked by Charlie Oct 19:

- Agents and MCP callers may POST a comment. It is stored with
  `author_kind: "agent"` (when `kind !== "human"` or `via === "mcp"`) plus
  `via` and an agent name label. They cannot pin, unpin, reorder or delete.
  There is no proposed flag: agents post directly.
- Pin, unpin and reorder are admin-only. Admins are `comments.admins`
  merged with the server-side `HUB_ADMINS` env var (comma-separated emails
  or `github:login`). This is app config only; Access is unchanged. An
  agent must not set `HUB_ADMINS` or name `comments.admins`.
- Delete is admin or the comment's own author, and person-only.
- Bodies are 8000 characters; a pinned top-level comment may be 256 KiB.
  A reply or unpinned comment over 8000 is refused with 413.
- `rev`, `edited_by` and `proposal_id` are stored so a later note proposal
  can target a pinned comment. Do not treat a reply as superseding a pin.

The vendorable core is `functions/_shared/hub-comments/`. Do not import
Access or `identity.js` from inside that folder.

Do not treat a comments document as a place for private reasoning, secrets,
or raw customer data. The existing notes store stays in place until a human
runs `scripts/migrate-notes-to-comments.mjs --apply` and chooses a cutover.
