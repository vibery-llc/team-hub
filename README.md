# team-hub

**A private hub for your team, deployed as plain files.** Live repo and board
stats, a searchable meeting archive, a file store that takes multi-gigabyte
builds, and one-click agent launch off any ticket — behind a login, on
Cloudflare's free tier, with **no build step at all**.

No bundler. No `node_modules` in the deploy. No framework. `site/` is what
ships, and you can open it in any static server and see the real thing.

---

## Why this exists

Teams working with coding agents end up needing the same handful of things:
somewhere to see what is actually happening, somewhere to put a build that is
too big for chat, somewhere the last meeting's decisions do not evaporate, and
some way to get from "this ticket should be done" to an agent session without
copy-pasting three times.

That is usually five SaaS subscriptions and a Slack channel. This is one repo.

| | |
|---|---|
| **Dashboard** | Live GitHub + board stats, epic timeline, KPIs, the latest uploaded images and videos, and a queue of agent-ready tickets with one-click launch into Claude Code, Codex or your clipboard |
| **Meetings** | Summary, decisions, action items with contextual buttons, publishable clips, and a searchable transcript with visible redaction markers |
| **Files & builds** | Drag-and-drop upload to R2, chunked so a multi-gigabyte build works, per-platform "download latest", image and video previews |
| **Activity (optional)** | Human-owned, agent-friendly workstream updates that stay concise and point to the true project records; absent until a human opts in |
| **Feedback (optional)** | A claimable queue of page-scoped items with a comment thread; absent from the nav until a human opts in |
| **Pinned notes (optional)** | A note on each page. Agents may propose an update; a human must approve it before it is pinned |
| **Comments (optional, no UI yet)** | Unified threads on a page, a service, or home. A comment can be pinned. Off until a human sets `comments.enabled` |
| **Setup / Guide / Resources** | Onboarding pages your team owns. Setup is a real agent-install walkthrough; the other two ship as examples to replace |
| **MCP server** | The hub itself is an MCP server, so an agent in your repo can read meetings, action items and the ticket queue instead of a human relaying them |

Everything sits behind Cloudflare Access, so it is private without you running
an auth system.

## What it looks like

Every screenshot below is a **fresh clone with nothing configured** — the
fictional example team this repo ships with. That is what you get before you
have edited anything.

### Dashboard

Live PRs and commits, epics rolled up from their child tickets, and a queue of
agent-ready tickets with a prompt button each.

![Dashboard](docs/screenshots/dashboard.png)

### Meetings

Summary, decisions, action items with contextual buttons, clips, and a
searchable transcript with visible redaction markers.

![Meetings](docs/screenshots/meetings.png)

### Files & builds

Newest build per platform, an archive, and a drop zone that chunks large uploads
into R2 — a multi-gigabyte build is fine.

![Files and builds](docs/screenshots/files.png)

### Activity, after opt-in

A human-owned workstream trail with concise updates and links back to the real
project records. The active view and navigation item are absent until enabled.

![Activity](docs/screenshots/activity.png)

![Activity in light mode](docs/screenshots/activity-light.png)

### Pipeline scoreboard, after opt-in

An at-a-glance status strip showing PASS/WAIT/FAIL gauges with evidence. Read
from a `snapshot.json` you maintain, rendered on the dashboard homepage.

Converges with existing hub KPI patterns — no competing ladder-style strips.
Supports project theming via `hub.config.js` and export to shareable HTML/PNG.

Enable in `hub.config.js`:

```javascript
pipelineScoreboard: {
  enabled: true,
  board: "your-project-board-id",
  snapshotPath: "snapshot.json",
}
```

See `docs/pipeline-scoreboard-schema.md` for snapshot format and theming options.

### Setup

An onboarding page that walks a teammate from nothing to a working agent.

![Setup](docs/screenshots/setup.png)

### Light and dark

The palette is defined twice and follows the reader's system setting.

![Dashboard in light mode](docs/screenshots/dashboard-light.png)

## Cost

Cloudflare Pages, Functions and R2 all have free tiers this fits inside
comfortably. A typical hub costs **$0/month**. R2 charges for storage past 10 GB,
which you will only reach if you keep a lot of builds.

---

## Quick start

```bash
gh repo fork vibery-llc/team-hub --clone --fork-name my-team-hub
cd my-team-hub
node scripts/init.mjs
```

`init.mjs` asks five questions, writes `hub.config.js` and `wrangler.toml`,
optionally creates the Cloudflare Pages project and R2 bucket, optionally sets
your GitHub secrets, and then prints the Cloudflare Access steps — which are
dashboard-only and cannot be scripted.

It is also non-interactive if you would rather script it:

```bash
node scripts/init.mjs --yes --org="Acme Robotics" --project=Fathom \
  --repo=acme/fathom --hub=fathom-hub
```

`--dry-run` prints what it would do and touches nothing. Under `--yes`, anything
that creates a cloud resource still defaults to *no* — you opt in with
`--create-resources`, so an unattended run can never quietly provision
infrastructure.

Then push to `main`. The workflow refreshes data and deploys.

The scheduled run also commits the refreshed `data.json` and `history.json` back to `main`. If `main` is protected by a ruleset that requires pull requests, that push is refused and the daily history stops growing, although the site still deploys with fresh data and the run shows a warning. To keep the history, add a secret named `DATA_PUSH_TOKEN`: a token with Contents write access, from an account that is on the ruleset's bypass list. It is separate from `GH_PAT`, which stays read-only.

> **Do the Access step before you put anything real in it.** Until that
> application exists, your hub is publicly readable. `init.mjs` says so too.

### What you edit

Two things:

- **`site/hub.config.js`** — one commented file. Org, site name, nav, repo,
  tracker, phase plan, dashboard links, agent prompt templates, the optional
  Unity `game` block, the optional activity-log opt-in, and the optional
  feedback-queue, pinned-notes and comments flags.
- **`site/brand/`** — `mark.png` plus `mark-32.png` and `mark-64.png`.

That is the whole of "who this hub belongs to". Everything else is generic.

A fresh clone renders a **complete working hub** for a fictional team (Northwind
Labs / Atlas) — populated dashboard, example meeting with a transcript, the lot
— so you can see what you are configuring before you configure it. Replace the
example meeting in `site/meetings/` with a real one, or delete it.

---

## How it works

### One config file, two consumers, no build step

`hub.config.js` assigns a global rather than exporting. The browser loads it
with a plain `<script>` tag — no fetch, and no flash of an unbranded header —
and `scripts/fetch-data.mjs` imports the same file under Node and reads
`globalThis.HUB_CONFIG`. One definition of your repo and board, used by both,
with no generated copy to drift.

### The shell is not in the pages

Every page ships an empty `<header data-hub-shell>` and
`<footer data-hub-shell>`; `hub.js` fills them from the config. Which nav link
is active comes from the URL, not a per-page marker. So the brand appears once
in the repo, and adding a nav item is a one-line edit instead of a six-file one.

### Cache correctness without content hashing

No build step means no content hashes. `site/_headers` serves `hub.js`,
`hub.config.js` and `style.css` with `Cache-Control: no-cache`, so the browser
revalidates against its ETag and Pages answers `304` when nothing changed. There
is no version number to bump and nothing to forget.

### Running without an issue tracker

Set `tracker: null` and the hub runs on GitHub alone. Every board-derived
section is **removed from the page**, not left empty: the epic hero, the
timeline, the agent queue, the In review and Recently done folds, the "tickets
done" KPI, and each of their jump links. What is left is Open PRs, three GitHub
KPIs, recent media and Links — a smaller hub, not a broken one.

`kind: "jira"` is the only tracker adapter implemented today. The seam for
others is in `scripts/fetch-data.mjs`.

### Uploaded images and videos preview in place

The Files page and the dashboard show the images and videos people upload
(`share/`, `clips/`, `meetings/`) as thumbnails; one click opens a picture
full size or plays a video, with seeking, straight from R2. To put a
screenshot or a capture in front of the team, upload it, by hand or with the
MCP `upload_file` tool. `/api/dl` shows only raster images, video and audio
inline; anything else, SVG and HTML included, downloads, so an upload can't
run script on the hub.

### The agent launcher

Prompt templates live in `hub.config.js` as text with `{key}`, `{summary}`,
`{done}`, `{branch}` and `{repo}` placeholders. Every launcher only **pre-fills**
a prompt box — none of them send. That is the documented behaviour of all the
URL schemes involved, and it is why a one-click launcher on a web page is safe
at all: the worst a bad link can do is put text in front of you.

Anything without a documented deep link falls back to the clipboard, and the
button says which happened.

### Agent-ready tickets

A ticket carrying a `Done =` acceptance line is treated as an agent-ready spec,
and only those appear in the dashboard queue. The dashboard also reports the
gap — "4 of 19 To Do tickets are agent-ready" — because a queue that silently
shows 4 of 19 reads as broken, and naming the shortfall turns the filter into a
visible prompt to write the line.

---

## Layout

```
site/                 what deploys — plain files, no build
  hub.config.js       ← who this hub belongs to
  brand/              ← your images
  hub.js              shell, agent launcher, lightbox, folds
  _headers            cache rules
  data.json           written by scripts/fetch-data.mjs
  activity.json       optional, human-owned workstream pointers
  feedback.html       optional claimable queue (opt-in via hub.config.js)
  meetings/           one JSON per meeting + transcripts
functions/            Pages Functions — AT THE PROJECT ROOT, see below
  api/                R2 file store, usage, feedback, notes, proposals, comments
  _shared/hub-comments/  vendorable comments core (no Access or identity imports)
  mcp/                MCP server over Streamable HTTP
scripts/
  init.mjs            first-run setup
  fetch-data.mjs      refresh data.json from GitHub + the tracker
  add-activity.mjs    append a validated update after human opt-in
  publish-build.mjs   upload a locally-built artifact to builds/<platform>/
  migrate-notes-to-comments.mjs  dry-run mapper from notes/pages onto comments/
```

**`functions/` is at the project root on purpose.** With
`pages_build_output_dir` set, Pages discovers Functions beside `wrangler.toml`.
A `functions/` folder inside the output directory is silently ignored — the
deploy goes green and every API route 404s.

## File storage

Pages refuses any static asset over 25 MiB, so builds and recordings go to R2
through `functions/api/`. Uploads under ~80 MB go in one request; anything
larger is sliced into 32 MB chunks in the browser and reassembled with R2's
multipart API, so a multi-gigabyte build uploads fine despite the ~100 MB cap on
a Pages request body. A failed chunk aborts the whole upload rather than leaving
a half-written object.

Four areas, and the API rejects anything outside them (plus `..`, backslashes
and odd characters): `builds/`, `share/`, `meetings/`, `clips/`.

Everything inherits the Access gate, and Access forwards the verified email,
which the API records as the uploader — never a client-supplied name.

## Publishing a build

The Files page's "download latest build" cards read from `builds/<platform>/`
in R2 — but nothing puts a build there on its own, deliberately. This template
cannot assume it can build your project: the first tenant it shipped with
builds a Unity game against a machine-bound license with no CI at all, and
other tenants will have their own reasons a build can only happen on
someone's machine. So there is no build workflow here, only an on-ramp: run
this after building locally.

```bash
export HUB_URL=https://my-hub.pages.dev
cloudflared access login "$HUB_URL"    # once; opens the browser

node scripts/publish-build.mjs ./dist/MyGame-1.4.0.zip windows
```

It drives the same chunked multipart route the Files page uses in the
browser, so a multi-gigabyte build is fine. Any failure aborts the multipart
upload so no partial object is left in the bucket, and it refuses to
overwrite an existing key — it suggests a versioned `--name` instead. On
success it prints the download URL. Run it with `--help` for the full option
list, or `--dry-run` to see what it would do without uploading anything.

Versioned names work well as semver + date + branch, e.g.
`MyGame-v0.1.0-2026-01-15-main-macos.zip` — date and branch keep every upload
unique without bumping the semver per build. `--latest-json=<file>` uploads
that JSON alongside as `builds/<platform>/latest.json`, the one key the API
lets a publish overwrite, so tooling can poll a stable URL for the newest
build. The Files page skips it when it builds the download cards.

For Unity teams there is one more piece: a `game` block in `hub.config.js`
puts a card on Setup and Files with the project's pinned Editor version —
Unity Hub deep link, download and archive links, and the player version.
`scripts/fetch-data.mjs` keeps it live from `ProjectSettings/ProjectVersion.txt`
and `PlayerSettings.bundleVersion` on the configured ref of the team repo;
the config block is the fallback when GitHub is unreachable. The block is
documented where you would set it, in `site/hub.config.js`.

The script signs in as you through [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/),
so the upload is recorded against your email, and it prints who it is
publishing as before any bytes move. A build machine with nobody at it sets
`HUB_ACCESS_ID` and `HUB_ACCESS_SECRET` to an Access service token instead
(Access → Service Auth, then add it to the application's policy with Action:
Service Auth). The token wins when both are present, and the script never logs
or prints it.

## Connecting an agent (MCP)

`functions/mcp/` serves a Model Context Protocol server over Streamable HTTP:
`list_meetings`, `get_meeting`, `search_transcript`, `list_action_items`,
`list_agent_ready_tickets`, `list_files`, `latest_build`, `upload_file`,
`start_large_upload`, `list_feedback`, `get_feedback`, `create_feedback`,
`comment_on_feedback`, `claim_feedback`, `list_notes`, `propose_note`,
`list_note_proposals`.

Hand-rolled JSON-RPC rather than the MCP SDK, because this repo has no build
step and a dependency would mean adding `package.json` plus an npm install for
four protocol methods.

Each person's agent signs in as that person, in the browser, the same way
they reach the site. That needs one setting: in Zero Trust, open the Access
application's **Advanced settings** and turn on **Managed OAuth**. Access then
answers an agent that has no token with a 401 that starts the standard MCP
sign-in, and forwards the person's email on every request after. Before turning
it on, set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.toml` (both
documented there). Cloudflare requires an MCP server behind Managed OAuth to
check the JWT Access signs onto each request, and with those two set, the
Functions do: a request without a valid one is refused, and the email is read
from inside it rather than from a header anyone could send.

```bash
# Claude Code
claude mcp add --transport http --scope user my-hub https://my-hub.pages.dev/mcp
claude mcp login my-hub

# Codex
codex mcp add my-hub --url https://my-hub.pages.dev/mcp
codex mcp login my-hub

# Cursor: add { "url": "https://my-hub.pages.dev/mcp" } under mcpServers in
# ~/.cursor/mcp.json, then sign in from Settings → MCP (or `cursor-agent mcp login my-hub`)
```

Uploads an agent makes are recorded against the person who signed in.
`start_large_upload` hands the agent plain HTTPS requests to make for the
chunks; the agent authenticates those with `cloudflared access curl`, as
above.

## Optional shared activity log

The Activity page is a small, centralized status trail for a team that wants
one. It is deliberately **off by default**: no navigation item appears and the
authoring command refuses to write until a human changes both settings in
`site/hub.config.js`:

```js
activityLog: {
  enabled: true,
  owner: "Jordan Lee",
  dataFile: "activity.json",
},
```

`owner` is the human accountable for what appears in the log. Agents never
enable the feature or choose the owner. After the owner explicitly asks for an
update, an agent can use the repository-owned command:

```bash
node scripts/add-activity.mjs \
  --kind=milestone \
  --workstream="Save flow" \
  --summary="Restart recovery now preserves the selected slot." \
  --link="Pull request|https://github.com/acme/widget/pull/42"
```

Kinds are `outcome`, `milestone`, `decision`, `blocker`, and `next-step`. The
command requires a single-line summary of at most 280 characters and at least
one labelled HTTPS link. It records the configured human owner, prepends the
entry to `site/activity.json`, and asks the agent to review the diff. The detail
stays in the linked PR, ticket, decision record, release, or other canonical
project system.

Put the rule in front of agents by keeping this template's `AGENTS.md` in your
hub fork. It requires explicit human opt-in and a direct request before every
post. Humans remain accountable for decisions and external actions.

**This is not a reasoning or monitoring feed.** Never post private reasoning
traces, messages, credentials, personal data, raw customer data, raw logs, or
secrets. The owner label is the minimum approved attribution, not permission to
include other personal information.

**Access protects the deployed site, not the source repository.** Activity data
is committed as a plain file. If updates are internal, keep the hub repository
private and review the diff before pushing; history in a public repository is
public even when the Pages site is behind Cloudflare Access.

## Usage stats

The dashboard's delivery activity says what shipped. It says nothing about
whether the team actually opens the hub or uses the agent launcher — so
there was no way to tell if anyone but the person who set it up ever had.

`functions/api/` records a **usage event** (`page_view` from every page load,
`agent_launch` from every click of an agent button) to R2 under a dated
`usage/<YYYY-MM-DD>/` prefix, fire-and-forget from `site/hub.js` — a failed or
slow event POST never blocks or delays the thing it is recording. The
dashboard's Usage panel calls `GET /api/stats`, which rolls the last 30 days
of events up into aggregate counts.

**Two modes, and only one of them is a tenant's decision to make:**

- **Anonymous aggregate counts — the default, no opt-in needed.** Every event
  carries a type, a label, a source and a server-set timestamp. No identity of
  any kind is recorded, attempted, or derivable. The dashboard shows totals:
  how many opens, how many launches, over the last 30 days.
- **Per-person attribution — opt-in, exactly like the activity log above.**
  Setting `usageStats.attribution.enabled: true` in `site/hub.config.js`
  **and** naming a human `owner` has the server additionally attach the
  Cloudflare Access-verified email to each event — never a client-supplied
  one; `functions/api/[[route]].js` reads it off the same
  `Cf-Access-Authenticated-User-Email` header the file store already trusts
  for uploads. Agents must never turn this on or name the owner — see
  `AGENTS.md`. When it is on, the dashboard's Usage panel says so with a
  visible callout instead of quietly starting to name names; that callout is
  driven by what `/api/stats` actually finds in R2, not by echoing the config
  flag, so it cannot drift from what the hub is really recording.

```js
usageStats: {
  attribution: {
    enabled: true,
    owner: "Jordan Lee",
  },
},
```

Usage events accumulate in R2 like anything else the API writes — small JSON
objects, cheap on the free tier — and nothing prunes them automatically today.

## Feedback queue and pinned notes

Two optional collaborative surfaces, both off until a human sets the flag in
`site/hub.config.js`. They live in R2 (not in git), behind the same Access
gate as the file store.

```js
feedback: { enabled: true },
notes: { enabled: true },
comments: { enabled: false, admins: [] },
```

**Feedback.** A claimable queue of items scoped to a hub page (`index`,
`meetings`, …). Each item has a comment thread. The Feedback page is the
whole queue; every other page grows a "Feedback on this page" panel when
the flag is on. Statuses are `open`, `claimed` and `done`. Claiming is
exclusive — a second claimant gets `409`. Agents may file, comment and
claim through MCP.

**Pinned notes.** One note per page. A human can edit it in the hub. An
agent may only *propose* an update (`propose_note`). Approve and reject are
browser-only: a headerless POST (MCP, curl) is refused, even with a valid
Access JWT. Approving writes the proposal body onto the pinned note.

**Cross-site writes are refused.** Mutating requests to the feedback, notes
and proposals routes, and MCP tools that write those stores, are refused
when `Origin`, `Referer` or `Sec-Fetch-Site` names a different host. A
signed-in person who also has another site open cannot be made to pin a
note or file feedback from that other origin. Read tools and headerless
same-site callers (MCP, `cloudflared access curl`) still work.

**Unified comments** sit behind `comments.enabled` (off by default) and have
no UI yet. One JSON document per `{scope, target_id}` lives at
`comments/{scope}/{target_id}.json`. Writes are etag-conditional with a
bounded retry. The file API refuses the `comments/` prefix.

The store and policy live in `functions/_shared/hub-comments/`, a vendorable
folder with no imports outside itself. Routes and identity glue stay in
`functions/api/` and `functions/_shared/comments.js`. Callers inject
`{ bucket, identity: { id, email, kind, via, idp }, config: { admins, adminIdps, limits }, now }`.
The same core is meant to land in compass-city-hub and kf-hub.

Locked by Charlie Oct 19: agents may POST a comment (stored with
`author_kind: "agent"`) but cannot pin, unpin, reorder or delete; pin/unpin/
reorder are admin-only; delete is admin or the author, and person-only.
`author_kind` is `"agent"` when `identity.kind !== "human"` or `via === "mcp"`.
The stored comment keeps `via`. The API refuses pin, unpin, reorder and
delete for `via=mcp` or a non-human kind.

**Who is an admin** (Charlie, Oct 19: developers are admins by default and
may whitelist non-developers):

```
isAdmin = signedInViaGitHub || HUB_ADMINS.includes(email)
```

- Anyone who signs in to Access through the **GitHub** identity provider is
  a hub admin.
- `HUB_ADMINS` (server-side env var, comma-separated emails, merged with
  `comments.admins` in `hub.config.js`) is the allowlist of extra admins
  who sign in another way (Google Workspace, email one-time code). Matching
  is case-insensitive. `github:login` entries are ignored.
- Everyone else is a normal user: they can comment and edit or delete their
  own comments, but cannot pin, unpin, reorder, delete other people's
  comments, or edit (approve edits to) someone else's pinned comment.
- Agents and MCP callers stay bot-labeled add/list only, whatever provider
  their person signed in with: admin rights need a same-site human browser.

The Access JWT does not say which identity provider was used, so the
Functions ask Access: `GET /cdn-cgi/access/get-identity` on the hub's own
host, with the `CF_Authorization` cookie (or the `Cf-Access-Jwt-Assertion`
token), and read `idp.type === "github"` (`accessIdp()` in
`functions/_shared/access.js`). It runs only on comments routes, only when
the flag is on and Access is configured (`ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD`), and only after the JWT has been verified. It **fails
closed**: a lookup that errors, times out, is not JSON, has no `idp`, or
names a different email than the verified JWT counts as "not GitHub", so
the person is an admin only if `HUB_ADMINS` lists them. Without Access
configured (`wrangler pages dev`) nobody is a GitHub admin.

This is app config only; Cloudflare Access policies are unchanged. Keep the
`wrangler.toml` entry a placeholder in this repo and set the real value per
deployment.

Bodies are 8000 characters by default. A pinned top-level comment may be up
to 256 KiB so a long service note can migrate losslessly. Editing at that
size needs a human browser caller who is an admin or the author; any
other caller, including an admin via MCP, stays at 8000 and gets `413`
above that. A reply or unpinned comment over 8000 gets `413`. Unpinning
a body over 8000 is `409` until the body is trimmed. Each comment has
`rev` (a per-comment revision string, `"1"` on create, seeded from the
legacy etag on migration, bumped on a body edit), `edited_by` and
`proposal_id` (nullable) so a later note proposal can target a pinned
comment without a reply marking it superseded.

A pinned comment's body is edited directly only by an admin or its author.
Everyone else must propose. Approve is a later slice; the API refuses the
direct edit and `can_edit` matches.

Access (`access.js`) only returns email. A service-token JWT has no
email; its stable id is `common_name`. The comments glue reads that
claim only when Access is configured (`ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD` both set). Otherwise the JWT was never verified and
`common_name` is ignored.

List and pins responses include `author_kind`, `author_label`, `via`,
`rev`, `edited_by`, `proposal_id`, an optional plain-text `quote` (max 500),
and per-viewer `can_edit` / `can_delete` / `can_pin` plus
`viewer: { can_pin, is_admin }` so a UI can hide menu items. The server
still enforces the same rules.

To preview mapping today's page notes onto that store:

```bash
node scripts/migrate-notes-to-comments.mjs --source-dir=./r2-dump
```

Dry-run is the default. `--apply` writes comment documents only. It never
writes or deletes `notes/` keys. A later compass-city-hub adapter
(`notes/*.md`, `service-YYYY-MM-DD.md` becoming `scope=service`) is stubbed
in the same script.

Agents must not turn these flags on, and must not treat a pending proposal
as published. See `AGENTS.md`.

## Publishing a meeting

1. Transcribe locally — audio never leaves the machine:
   ```bash
   ffmpeg -i recording.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le meeting.wav
   whisper meeting.wav --model large-v3 --output_format json
   ```
2. Turn the raw Whisper JSON into everything the Meetings page needs, in one
   command:
   ```bash
   node scripts/publish-meeting.mjs \
     --input=meeting.json --id=2026-08-16 --title="Weekly sync — 16 Aug 2026" \
     --model="Whisper large-v3" \
     --redact=2382-2820:"off-topic tangent"
   ```
   This writes `<id>.json`, `<id>.transcript.json` and `<id>.transcript.txt`
   into `site/meetings/` and prepends an entry to `site/meetings/index.json`.
   The meeting JSON ships with every field the page renders, but the prose —
   blurb, summary, topics, decisions, action items, clips — is left empty for
   a human to write. `--redact` is repeatable and takes `start-end:reason` in
   seconds; matching segments are dropped before short fragments get merged
   into neighbouring lines, so withheld text can't survive by getting glued
   onto a line that ships.
3. Upload any clips worth keeping to `clips/` on the Files page and set each
   clip's `key`.

**Default to not publishing the full recording.** A meeting runs an hour and
carries things nobody meant to broadcast; the clips are the part with an
audience. Omit `videoKey` and the page says so plainly instead of offering a
player.

Withhold stretches with a `redactions` entry and a marked segment, so a gap is
visible where it happens rather than a silent jump in the timestamps. Transcripts
are small and worth versioning. Video never is — `.gitignore` keeps it out.

## Staying up to date

Your hub is a **fork**, not a copy. Adding this repo as `upstream` is what keeps
you on the improvements without re-doing your setup:

```bash
git remote add upstream https://github.com/vibery-llc/team-hub
git fetch upstream
git merge upstream/main
```

This works because your fork is the *same tree shape* as upstream, differing
only in files upstream does not compete for:

| yours | upstream's |
|---|---|
| `site/hub.config.js` | ships an example version |
| `site/brand/` | ships a placeholder mark |
| `site/data.json`, `site/activity.json`, `site/meetings/` | ships example data |
| `wrangler.toml` | ships placeholder names |
| `guide.html`, `resources.html` | ships example prose |

Everything else — `hub.js`, `style.css`, `index.html`, `meetings.html`,
`files.html`, `activity.html`, `feedback.html`, `setup.html`, `functions/`,
`scripts/` — should be **byte-identical to upstream**, and those merges
fast-forward cleanly.

### The conflict is the feature

If a merge conflicts in a product file, that is the point. It means someone
edited product code locally instead of putting the change in config, and you are
finding out now rather than discovering six months of accumulated drift when you
finally try to pull. Resolve it by moving the customisation into
`hub.config.js` — and if it cannot go there, that is a missing config key worth
[opening an issue](https://github.com/vibery-llc/team-hub/issues) about.

Conflicts in the tenant files above are ordinary and boring. `git checkout
--ours` is usually right for `guide.html` and `resources.html`; for
`hub.config.js`, read the upstream side, since a new key means a new feature you
can now switch on.

To see how far you have drifted before merging:

```bash
git fetch upstream
git diff upstream/main --stat -- site/hub.js site/style.css site/index.html \
  site/meetings.html site/files.html site/feedback.html functions/ scripts/
```

Empty output means zero drift. Anything listed is a local edit to product code
that will conflict eventually.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The no-build-step and no-tenant-strings
rules are the two that matter most.

## License

MIT — see [LICENSE](LICENSE).
