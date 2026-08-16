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
| **Dashboard** | Live GitHub + board stats, epic timeline, KPIs, screenshot strip, and a queue of agent-ready tickets with one-click launch into Claude Code, Codex or your clipboard |
| **Meetings** | Summary, decisions, action items with contextual buttons, publishable clips, and a searchable transcript with visible redaction markers |
| **Files & builds** | Drag-and-drop upload to R2, chunked so a multi-gigabyte build works, per-platform "download latest", screenshot gallery |
| **Activity (optional)** | Human-owned, agent-friendly workstream updates that stay concise and point to the true project records; absent until a human opts in |
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

> **Do the Access step before you put anything real in it.** Until that
> application exists, your hub is publicly readable. `init.mjs` says so too.

### What you edit

Two things:

- **`site/hub.config.js`** — one commented file. Org, site name, nav, repo,
  tracker, phase plan, dashboard links, agent prompt templates, and the optional
  activity-log opt-in.
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
KPIs, screenshots and Links — a smaller hub, not a broken one.

`kind: "jira"` is the only tracker adapter implemented today. The seam for
others is in `scripts/fetch-data.mjs`.

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
  meetings/           one JSON per meeting + transcripts
functions/            Pages Functions — AT THE PROJECT ROOT, see below
  api/                R2 file store: list, upload, chunked multipart, download
  mcp/                MCP server over Streamable HTTP
scripts/
  init.mjs            first-run setup
  fetch-data.mjs      refresh data.json from GitHub + the tracker
  add-activity.mjs    append a validated update after human opt-in
  publish-build.mjs   upload a locally-built artifact to builds/<platform>/
  sync-proof-shots.sh mirror screenshots out of PR bodies
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
export HUB_ACCESS_ID=...       # Access service token Client Id
export HUB_ACCESS_SECRET=...   # Access service token Client Secret

node scripts/publish-build.mjs ./dist/MyGame-1.4.0.zip windows
```

It drives the same chunked multipart route the Files page uses in the
browser, so a multi-gigabyte build is fine. Any failure aborts the multipart
upload so no partial object is left in the bucket, and it refuses to
overwrite an existing key — it suggests a versioned `--name` instead. On
success it prints the download URL. Run it with `--help` for the full option
list, or `--dry-run` to see what it would do without uploading anything.

`HUB_ACCESS_ID` and `HUB_ACCESS_SECRET` are the same kind of Cloudflare
Access service token described below for the MCP server — create one under
Access → Service Auth. The script reads both from the environment and never
logs or prints them.

## Connecting an agent (MCP)

`functions/mcp/` serves a Model Context Protocol server over Streamable HTTP:
`list_meetings`, `get_meeting`, `search_transcript`, `list_action_items`,
`list_agent_ready_tickets`, `list_files`, `latest_build`, `upload_file`,
`start_large_upload`.

Hand-rolled JSON-RPC rather than the MCP SDK, because this repo has no build
step and a dependency would mean adding `package.json` plus an npm install for
four protocol methods.

Machine clients authenticate with a Cloudflare Access **service token**, which
Access validates before the request reaches the Function — which is why there is
no second token check in the code.

```bash
claude mcp add --transport http my-hub https://my-hub.pages.dev/mcp \
  --header "CF-Access-Client-Id: $HUB_ACCESS_ID" \
  --header "CF-Access-Client-Secret: $HUB_ACCESS_SECRET"
```

Uploads made through a service token are recorded against the token, not a
person.

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

## Publishing a meeting

1. Transcribe locally — audio never leaves the machine:
   ```bash
   ffmpeg -i recording.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le meeting.wav
   ```
2. Drop `<id>.json` and `<id>.transcript.json` into `site/meetings/`, then add
   the meeting to `site/meetings/index.json`.
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
| `site/data.json`, `site/activity.json`, `site/meetings/`, `site/img/proof/` | ships example data |
| `wrangler.toml` | ships placeholder names |
| `guide.html`, `resources.html` | ships example prose |

Everything else — `hub.js`, `style.css`, `index.html`, `meetings.html`,
`files.html`, `activity.html`, `setup.html`, `functions/`, `scripts/` — should
be **byte-identical to upstream**, and those merges fast-forward cleanly.

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
  site/meetings.html site/files.html functions/ scripts/
```

Empty output means zero drift. Anything listed is a local edit to product code
that will conflict eventually.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The no-build-step and no-tenant-strings
rules are the two that matter most.

## License

MIT — see [LICENSE](LICENSE).
