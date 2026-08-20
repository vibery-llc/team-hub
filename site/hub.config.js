/* ---------------------------------------------------------------------------
   Tenant configuration. This file is the whole of "who this hub belongs to".

   Everything here is text and links — the pages, styles and Functions around it
   are generic. Editing this file plus swapping the images in site/brand/ turns
   this into your team's hub without touching a line of product code.

   It is a plain script assigning a global rather than JSON, for two reasons:
   it loads synchronously in <head>, so the shell renders with no flash of an
   unbranded header, and it can carry comments — which matters for the one file
   every new deployment is expected to edit.

   Loaded by every page as `<script src="hub.config.js"></script>`, before the
   deferred hub.js that reads it — and by scripts/fetch-data.mjs under Node,
   which imports this same file for the repo, tracker and phase settings. One
   file, two consumers, still no build step.

   The values below describe a fictional team, so a fresh clone renders a
   complete hub before you have changed anything. Replace them.
--------------------------------------------------------------------------- */

globalThis.HUB_CONFIG = {
  /* The small line above the site title in the header. */
  org: "Northwind Labs",

  /* The site title, in the header and in the browser tab. */
  siteName: "Atlas — Team Hub",

  brand: {
    /* Alt text for the mark. The image files themselves are site/brand/mark*.png
       — the paths are a product convention, so only the files are yours. */
    alt: "Northwind Labs",
    /* Intrinsic pixel size of brand/mark.png. CSS drives the displayed height;
       these are here so the browser reserves the right box before it loads. */
    markWidth: 512,
    markHeight: 512,
  },

  /* Shown in the footer of any page that does not name its own. */
  footer: "One set of gates for everyone · read the repo · prove the change",

  /* The nav, in order. `href` doubles as the page's identity: the link matching
     the current URL is marked active, and that entry's `title` and `footer`
     are used for the page. Drop an entry to remove the page from the nav.

     `title`  — browser tab text; defaults to "<label> — <siteName>".
     `footer` — footer text; defaults to `footer` above. */
  nav: [
    {
      href: "index.html",
      label: "Dashboard",
      title: "Atlas — Team Hub",
      footer: "Auto-refreshes on a schedule via GitHub Actions",
    },
    {
      href: "meetings.html",
      label: "Meetings",
      title: "Meetings — Atlas",
      footer: "Transcribed locally · full recordings are not published, only the clips the team selected",
    },
    {
      href: "files.html",
      label: "Files & builds",
      title: "Files & builds — Atlas",
      footer: "Files live in Cloudflare R2 · gated by Access",
    },
    {
      href: "activity.html",
      label: "Activity",
      title: "Team activity — Atlas",
      footer: "Concise pointers to the real project records · accountable to a human owner",
      feature: "activityLog",
    },
    { href: "setup.html", label: "Setup", title: "Setup — Get your agent running" },
    { href: "guide.html", label: "Guide", title: "Guide — How we work with agents" },
    { href: "resources.html", label: "Resources", title: "Resources — Working with agents 101" },
  ],

  /* The repository your team works in — NOT this hub's own repo. The agent
     launcher opens sessions against it, and fetch-data.mjs reads its PRs and
     commits. `gitUrl` is what Codex matches a local clone against. */
  repo: {
    slug: "northwind-labs/atlas",
    url: "https://github.com/northwind-labs/atlas",
    gitUrl: "https://github.com/northwind-labs/atlas.git",
  },

  /* How the project is named mid-sentence on the Setup page ("open your Atlas
     folder"), and what the checkout is usually called on disk. Anywhere a page
     needs one of these it uses <em data-hub-var="projectName"></em>, which is
     what keeps Setup a product page rather than a per-team copy. */
  projectName: "Atlas",
  repoDirName: "atlas",

  /* Optional — only for teams whose project is a Unity game. Declaring a
     `game` block puts a card on Setup and Files with the pinned Unity Editor
     version (Unity Hub deep link, download and archive links) and the player
     version, so nobody hunts chat history for "which Editor do I install".

     scripts/fetch-data.mjs keeps the card live: it reads
     ProjectSettings/ProjectVersion.txt and PlayerSettings.bundleVersion from
     `ref` of the repo above into data.json `project`. The values here are the
     fallback shown when GitHub is unreachable — bump them on an Editor
     upgrade if you cannot wait for the next scheduled refresh. Omit the whole
     block (the default) and nothing Unity-related renders anywhere.

  game: {
    ref: "main",
    unity: {
      editorVersion: "6000.0.0f1",   // ProjectVersion.txt m_EditorVersion
      changeset: "000000000000",     // the hash in m_EditorVersionWithRevision
    },
    app: {
      semver: "0.1.0",               // PlayerSettings.bundleVersion
      source: "PlayerSettings.bundleVersion",
    },
  },
  */

  /* Optional shared activity log. It is absent from navigation until a human
     explicitly enables it AND names the human who owns what gets published.
     Agents must never turn this on for themselves. Once enabled, an agent may
     add a concise entry with scripts/add-activity.mjs after the owner asks.

     Activity data is committed to the hub repo. Use a private repo for internal
     updates, and never put reasoning traces, messages, credentials, personal
     data, raw customer data, raw logs or secrets in the log. */
  activityLog: {
    enabled: false,
    owner: "",
    dataFile: "activity.json",
  },

  /* Usage stats — whether the hub is actually opened and used, beyond the
     person who set it up. Recording anonymous aggregate counts (page opens,
     agent launches) is a product default and needs no opt-in; this block
     controls only PER-PERSON ATTRIBUTION, which is a tenant policy decision,
     never an agent's to make.

     Leave `attribution.enabled` false and the dashboard's Usage panel shows
     totals with no identity attached anywhere. Set it to true AND name the
     human accountable for that decision, and the server additionally
     attaches the Cloudflare Access-verified email to each event — the
     dashboard then visibly says attribution is on, so teammates read about
     it rather than discover it. See README, "Usage stats". */
  usageStats: {
    attribution: {
      enabled: false,
      owner: "",
    },
  },

  /* Extra agent launchers, beyond the built-in Claude Code / Claude desktop /
     Claude in VS Code / Codex / Copy prompt. Use this for a tool specific to
     your stack rather than editing hub.js — an edit there is a merge conflict
     the next time you pull from upstream.

       id          stable key; also what gets saved as the user's preference
       label       button text
       note        tooltip
       urlTemplate deep link with a {prompt} placeholder, URL-encoded for you.
                   Omit it and the launcher copies to the clipboard instead,
                   which is the right answer for most tools.
       launch      a second URL opened after copying, to bring an app forward
       copies      true if the note already tells the user it copies

     Example — a tool with no documented deep link:

       { id: "acme", label: "Acme", note: "copies the prompt — paste it into Acme" }
  */
  launchers: [],

  /* How far back "this week in numbers" and "recently done" look. */
  windowDays: 7,

  /* The issue tracker, or `null` to run on GitHub alone — see the README under
     "Running without an issue tracker". `kind: "jira"` is the only adapter
     fetch-data.mjs implements today; the rest is where to reach your board. */
  tracker: {
    kind: "jira",
    baseUrl: "https://northwind-labs.atlassian.net",
    projectKey: "ATL",
    /* How the board is named in the UI, e.g. under the "tickets done" KPI. */
    label: "ATL board",
    boardUrl: "https://northwind-labs.atlassian.net/jira/software/projects/ATL/boards/1",
    timelineUrl: "https://northwind-labs.atlassian.net/jira/software/projects/ATL/boards/1/timeline",
  },

  /* The line under the phase-plan heading on the dashboard. */
  phasesBlurb: "The shared phasing for the current milestone, checked against what is actually in the repo.",

  /* The phase plan on the dashboard: which ticket stands for each phase.
     fetch-data.mjs looks each key up and attaches its live status, so the
     statuses here are never hand-maintained. An empty list hides the section. */
  phases: [
    { phase: "P0", key: "ATL-11", name: "Foundation", desc: "The thing everything else sits on" },
    { phase: "P1", key: "ATL-12", name: "Core loop", desc: "The path a user actually takes" },
    { phase: "P2", key: "ATL-13", name: "State", desc: "Persist it, sync it, restore it" },
    { phase: "P3", key: "ATL-14", name: "Risk spike", desc: "The part nobody is sure about yet" },
    { phase: "P4", key: "ATL-15", name: "End to end", desc: "Two machines, one flow" },
    { phase: "P5", key: "ATL-16", name: "QA + hardening", desc: "Before the slice ships" },
  ],

  /* The "Links" fold on the dashboard — wherever your team actually goes. */
  links: [
    { label: "GitHub · atlas", href: "https://github.com/northwind-labs/atlas" },
    { label: "Pull requests", href: "https://github.com/northwind-labs/atlas/pulls" },
    { label: "Jira · ATL board", href: "https://northwind-labs.atlassian.net/jira/software/projects/ATL/boards/1" },
    { label: "AGENTS.md", href: "https://github.com/northwind-labs/atlas/blob/main/AGENTS.md" },
    { label: "Zo Computer", href: "https://zo-computer.cello.so/7LkJkHv7gds" },
    { label: "This site's source", href: "https://github.com/vibery-llc/team-hub" },
  ],

  /* The prompt buttons on each agent-ready ticket. These are the most
     project-specific thing in this file — they encode your harness, your gates
     and your vocabulary, and they are worth rewriting rather than tweaking.
     The three below are a starting shape: orient, build, test.

     `text` is a template, not code. Placeholders filled per ticket:
       {key}      ticket id, e.g. ATL-42
       {summary}  ticket title
       {done}     the "Done =" acceptance line that made it agent-ready
       {branch}   suggested branch name, "{key}-<slug of summary>"
       {repo}     repo.slug above  */
  prompts: [
    {
      id: "orient",
      label: "Explain it first",
      hint: "read-only — best for your first few tickets",
      text: `{key} — {summary}

Acceptance: {done}

Read AGENTS.md before anything else. Do not change any files yet.

Tell me three things:
1. Which files this ticket touches.
2. What you would do, in order.
3. Where you think it could go wrong.`,
    },
    {
      id: "build",
      label: "Do it",
      hint: "the full path — branch, tests, PR, board",
      text: `{key} — {summary}

Acceptance: {done}

Read AGENTS.md before you start.

Set {key} to In Progress and assign it to me when you start, not after.
Branch {branch}. Quote every path that contains a space.
Run the test suite before pushing — a green run is the claim, not your summary of it.
Open a PR with {key} in the title, then comment the PR link on the ticket.`,
    },
    {
      id: "test",
      label: "Just the test",
      hint: "prove it's broken before fixing it",
      text: `{key} — {summary}

Acceptance: {done}

Read AGENTS.md first. Write only the failing test that proves this ticket is not done yet.

Do not implement the fix. Show me the test going red, and tell me exactly what green will mean.`,
    },
  ],
};
