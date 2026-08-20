#!/usr/bin/env node
/**
 * Refresh site/data.json from GitHub and the issue tracker.
 *
 * Which repo, which board and which phase tickets all come from
 * site/hub.config.js — the same file the pages read in the browser. This
 * script only supplies the credentials and does the fetching.
 *
 * Env:
 *   GH_TOKEN     — GitHub token with read access to config.repo.slug
 *   JIRA_EMAIL   — Atlassian account email
 *   JIRA_TOKEN   — Atlassian API token (id.atlassian.com → Security → API tokens)
 *   JIRA_BASE    — overrides config.tracker.baseUrl; normally unset
 *
 * Sections whose credentials are missing (or whose fetch fails) keep their previous
 * values from the committed data.json, so the site never renders empty.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site", "data.json");
const HISTORY_OUT = join(ROOT, "site", "history.json");
const HISTORY_CAP = 180;

/* hub.config.js assigns a global rather than exporting, so that the browser can
   load it with a plain <script> tag and skip a fetch. Importing it here for the
   side effect is what lets one file serve both without a build step. */
await import(pathToFileURL(join(ROOT, "site", "hub.config.js")).href);
const CONFIG = globalThis.HUB_CONFIG;
if (!CONFIG) throw new Error("site/hub.config.js did not set globalThis.HUB_CONFIG");

const REPO = CONFIG.repo?.slug;
if (!REPO) throw new Error("hub.config.js: repo.slug is required");

const TRACKER = CONFIG.tracker || {};
const JIRA_BASE = process.env.JIRA_BASE || TRACKER.baseUrl;
const PROJECT_KEY = TRACKER.projectKey;
const PHASES = CONFIG.phases || [];
const WINDOW_DAYS = CONFIG.windowDays || 7;
const since = new Date(Date.now() - WINDOW_DAYS * 864e5);

let data = {};
try { data = JSON.parse(readFileSync(OUT, "utf8")); } catch { /* first run */ }

async function gh(path, accept = "application/vnd.github+json") {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
  return accept.includes("raw") ? res.text() : res.json();
}

function parseEditorVersion(txt) {
  const editorVersion = txt.match(/^m_EditorVersion:\s*(\S+)/m)?.[1] || null;
  const changeset = txt.match(/^m_EditorVersionWithRevision:\s*\S+\s*\((\w+)\)/m)?.[1] || null;
  return { editorVersion, changeset };
}

function parseBundleVersion(asset) {
  // PlayerSettings.bundleVersion — not visionOSBundleVersion / tvOSBundleVersion.
  return asset.match(/^  bundleVersion:\s*(\S+)/m)?.[1] || null;
}

/* Mirrors unityLinks() in site/hub.js (the browser recomputes these as its
   fallback) — keep the URL shapes in sync. */
function unityLinks(editorVersion, changeset) {
  return {
    hubUri: editorVersion && changeset
      ? `unityhub://${editorVersion}/${changeset}`
      : editorVersion ? `unityhub://${editorVersion}` : "",
    downloadUrl: editorVersion
      ? `https://unity.com/releases/editor/whats-new/${editorVersion}`
      : "https://unity.com/releases/editor/archive",
    archiveUrl: "https://unity.com/releases/editor/archive",
  };
}

/** Live Unity Editor + player semver from the game repo, so the hub does not
 *  hardcode a version that drifts. Fallback values live in hub.config.js `game`. */
async function fetchProject() {
  const fallback = CONFIG.game || {};
  const ref = fallback.ref || "main";
  const [versionTxt, settings] = await Promise.all([
    gh(`/repos/${REPO}/contents/ProjectSettings/ProjectVersion.txt?ref=${encodeURIComponent(ref)}`, "application/vnd.github.raw"),
    gh(`/repos/${REPO}/contents/ProjectSettings/ProjectSettings.asset?ref=${encodeURIComponent(ref)}`, "application/vnd.github.raw"),
  ]);
  const { editorVersion, changeset } = parseEditorVersion(versionTxt);
  const semver = parseBundleVersion(settings);
  if (!editorVersion) throw new Error("ProjectVersion.txt had no m_EditorVersion");
  if (!semver) throw new Error("ProjectSettings.asset had no bundleVersion");
  const links = unityLinks(editorVersion, changeset);
  return {
    fetchedAt: new Date().toISOString(),
    ref,
    unity: { editorVersion, changeset, ...links },
    app: {
      semver,
      source: fallback.app?.source || "PlayerSettings.bundleVersion",
    },
  };
}

async function fetchGithub() {
  const prs = await gh(`/repos/${REPO}/pulls?state=all&per_page=100&sort=updated&direction=desc`);
  const open = prs
    .filter((p) => p.state === "open")
    .map((p) => ({ number: p.number, title: p.title, url: p.html_url, draft: p.draft, branch: p.head.ref }));
  const mergedRecent = prs
    .filter((p) => p.merged_at && new Date(p.merged_at) >= since)
    .map((p) => ({ number: p.number, title: p.title, url: p.html_url, mergedAt: p.merged_at }));
  const commits = await gh(`/repos/${REPO}/commits?since=${since.toISOString()}&per_page=100`);
  return {
    fetchedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    openPrs: open,
    mergedPrs: mergedRecent,
    commitCount: commits.length,
  };
}

async function jiraSearch(jql, fields) {
  const issues = [];
  let nextPageToken;
  do {
    const params = new URLSearchParams({ jql, fields, maxResults: "100" });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const res = await fetch(`${JIRA_BASE}/rest/api/3/search/jql?${params}`, {
      headers: {
        Authorization: "Basic " + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_TOKEN}`).toString("base64"),
        Accept: "application/json",
      },
    });
    if (!res.ok) throw new Error(`Jira search: ${res.status}`);
    const page = await res.json();
    issues.push(...(page.issues || []));
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return issues;
}

// Epic activity is derived from children — epic statuses aren't maintained on this board
// (all 10 sit at "To Do" regardless of real progress), and epics carry no dates.
function rollupEpics(issues) {
  const epics = new Map();
  for (const i of issues) {
    if (i.fields.issuetype?.name !== "Epic") continue;
    epics.set(i.key, {
      key: i.key,
      name: i.fields.summary,
      url: `${JIRA_BASE}/browse/${i.key}`,
      status: i.fields.status.name,
      dueDate: i.fields.duedate || null,
      total: 0, done: 0, inProgress: 0, inReview: 0, doneRecent: 0,
      lastActivity: null,
    });
  }
  for (const i of issues) {
    const e = epics.get(i.fields.parent?.key);
    if (!e) continue;
    const s = i.fields.status.name;
    e.total++;
    if (s === "Done") {
      e.done++;
      if (new Date(i.fields.updated) >= since) e.doneRecent++;
    } else if (s === "In Progress") e.inProgress++;
    else if (s === "In Review") e.inReview++;
    if (!e.lastActivity || i.fields.updated > e.lastActivity) e.lastActivity = i.fields.updated;
  }
  const state = (e) =>
    e.status === "Done" || (e.total > 0 && e.done === e.total) ? "done"
    : e.inProgress + e.inReview + e.doneRecent > 0 || e.status === "In Progress" ? "active"
    : "upcoming";
  const rank = { done: 0, active: 1, upcoming: 2 };
  return [...epics.values()]
    .map((e) => ({ ...e, state: state(e) }))
    .sort((a, b) =>
      rank[a.state] - rank[b.state] ||
      (a.state === "active" ? (b.lastActivity || "").localeCompare(a.lastActivity || "") : 0) ||
      a.key.localeCompare(b.key, undefined, { numeric: true }));
}

// Jira v3 returns descriptions as ADF (a node tree), not markdown. Walk it for text
// and keep block boundaries as newlines so a "Done =" line stays on its own line.
function adfToText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const inner = (node.content || []).map(adfToText).join("");
  const isBlock = ["paragraph", "heading", "listItem", "blockquote", "codeBlock", "panel"].includes(node.type);
  return isBlock ? `${inner}\n` : inner;
}

// The Guide's convention: a BF ticket carrying a "Done =" acceptance line IS an
// agent-ready spec. That makes the filter honest — and gives writing the line a
// point, since tickets without one simply don't appear in the queue.
const ACCEPTANCE = /^\s*Done\s*[=:]\s*(.+)$/im;

function agentReadyQueue(issues) {
  const todo = issues.filter(
    (i) => i.fields.issuetype?.name !== "Epic" && i.fields.status.name === "To Do",
  );
  const ready = todo
    .map((i) => {
      const text = adfToText(i.fields.description).replace(/\n{3,}/g, "\n\n").trim();
      const done = text.match(ACCEPTANCE)?.[1]?.trim();
      return done
        ? {
            key: i.key,
            summary: i.fields.summary,
            url: `${JIRA_BASE}/browse/${i.key}`,
            done,
            assignee: i.fields.assignee?.displayName ?? null,
            epic: i.fields.parent?.fields?.summary ?? null,
            updated: i.fields.updated,
          }
        : null;
    })
    .filter(Boolean)
    // Unclaimed first — those are the ones anyone can pick up — then most recently touched.
    .sort((a, b) =>
      Number(Boolean(a.assignee)) - Number(Boolean(b.assignee)) ||
      (b.updated || "").localeCompare(a.updated || ""));
  // Report the gap, don't hide it. Most To Do tickets have no acceptance line, and a
  // queue that silently shows 2 of 30 reads as broken. Naming the shortfall turns the
  // filter into a visible prompt to write the line.
  return { tickets: ready.slice(0, 12), todoTotal: todo.length, readyTotal: ready.length };
}

async function fetchJira() {
  const issues = await jiraSearch(
    `project = ${PROJECT_KEY}`,
    "summary,status,issuetype,updated,parent,duedate,description,assignee",
  );
  const byKey = Object.fromEntries(issues.map((i) => [i.key, i]));
  // The page links each phase straight from this url, so it never has to know
  // the tracker's URL shape.
  const phases = PHASES.map((p) => ({
    ...p,
    url: `${JIRA_BASE}/browse/${p.key}`,
    status: byKey[p.key]?.fields.status.name ?? "Unknown",
    summary: byKey[p.key]?.fields.summary ?? "",
  }));
  const statusCounts = {};
  for (const i of issues) {
    const s = i.fields.status.name;
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  const doneRecent = issues
    .filter((i) => i.fields.status.name === "Done" && new Date(i.fields.updated) >= since)
    .sort((a, b) => new Date(b.fields.updated) - new Date(a.fields.updated))
    .slice(0, 12)
    .map((i) => ({ key: i.key, summary: i.fields.summary, url: `${JIRA_BASE}/browse/${i.key}` }));
  const inReview = issues
    .filter((i) => i.fields.status.name === "In Review")
    .map((i) => ({ key: i.key, summary: i.fields.summary, url: `${JIRA_BASE}/browse/${i.key}` }));
  return {
    fetchedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    totalIssues: issues.length,
    statusCounts,
    epics: rollupEpics(issues),
    phases,
    doneRecent,
    inReview,
    agentReady: agentReadyQueue(issues),
  };
}

let ok = true;
/* Did any source actually answer? A run where everything was skipped or failed
   has nothing new to say. Stamping generatedAt anyway would make data.json
   differ on every single run, which the workflow reads as "the data changed"
   and commits — a timestamp-only commit every six hours, forever, on any hub
   whose credentials are missing or have lapsed.

   It also makes the field honest: the page renders it as "data refreshed
   <time>", and that should be when the data was last refreshed, not when the
   script last ran and got nowhere. */
let refreshed = false;

if (process.env.GH_TOKEN) {
  try { data.github = await fetchGithub(); refreshed = true; console.log("github: refreshed"); }
  catch (e) { ok = false; console.error("github: FAILED —", e.message, "(keeping previous data)"); }
  /* Unity-game tenants only — a `game` block in hub.config.js opts in.
     Hubs without one never look for ProjectSettings in the repo. */
  if (CONFIG.game) {
    try {
      data.project = await fetchProject();
      refreshed = true;
      console.log(`project: Unity ${data.project.unity.editorVersion} · app ${data.project.app.semver} @ ${data.project.ref}`);
    } catch (e) {
      ok = false;
      /* A cached project from a different ref is worse than the config
         fallback — it recommends the wrong Editor with confidence. */
      if (!data.project || data.project.ref !== (CONFIG.game.ref || "main")) {
        data.project = {
          fetchedAt: null,
          ref: CONFIG.game.ref || "main",
          unity: {
            editorVersion: CONFIG.game.unity?.editorVersion,
            changeset: CONFIG.game.unity?.changeset,
            ...unityLinks(CONFIG.game.unity?.editorVersion, CONFIG.game.unity?.changeset),
          },
          app: CONFIG.game.app || { semver: "0.1.0", source: "PlayerSettings.bundleVersion" },
        };
        console.error("project: FAILED —", e.message, "(seeded from hub.config.js game fallback)");
      } else {
        console.error("project: FAILED —", e.message, "(keeping previous data)");
      }
    }
  } else if (data.project) {
    /* The tenant opted back out — a stale card must not outlive the config. */
    delete data.project;
    refreshed = true;
    console.log("project: removed (no game config)");
  }
} else console.warn("github: GH_TOKEN not set, keeping previous data");

if (TRACKER.kind && TRACKER.kind !== "jira") {
  console.warn(`tracker: "${TRACKER.kind}" has no adapter — jira is the only one implemented`);
} else if (!JIRA_BASE || !PROJECT_KEY) {
  console.warn("tracker: hub.config.js has no tracker.baseUrl/projectKey, keeping previous data");
} else if (process.env.JIRA_EMAIL && process.env.JIRA_TOKEN) {
  try { data.jira = await fetchJira(); refreshed = true; console.log("jira: refreshed"); }
  catch (e) { ok = false; console.error("jira: FAILED —", e.message, "(keeping previous data)"); }
} else console.warn("jira: JIRA_EMAIL/JIRA_TOKEN not set, keeping previous data");

if (refreshed) data.generatedAt = new Date().toISOString();
else console.warn("nothing refreshed — leaving generatedAt alone so the file is unchanged");
writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
console.log(`wrote ${OUT}`);

/* One dated snapshot per UTC day, so the dashboard can show "up from 6" instead of
   just "11" this run. The job fires several times a day, so a run on a day that
   already has a snapshot overwrites it rather than piling up duplicates — the
   snapshot reflects the day's latest known numbers, not every run of it. Skipped
   entirely when neither source has ever produced data, so a hub with no
   credentials yet doesn't start writing a history of nothing. */
if (data.github || data.jira) {
  let history = [];
  try { history = JSON.parse(readFileSync(HISTORY_OUT, "utf8")); } catch { /* first run */ }
  if (!Array.isArray(history)) history = [];

  const today = new Date().toISOString().slice(0, 10); // UTC date
  const snapshot = {
    date: today,
    openPrs: data.github ? (data.github.openPrs || []).length : null,
    mergedPrs: data.github ? (data.github.mergedPrs || []).length : null,
    commitCount: data.github ? data.github.commitCount ?? null : null,
    ticketsDone: data.jira ? (data.jira.doneRecent || []).length : null,
  };

  history = history.filter((h) => h.date !== today);
  history.push(snapshot);
  history.sort((a, b) => a.date.localeCompare(b.date));
  if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP);

  writeFileSync(HISTORY_OUT, JSON.stringify(history, null, 2) + "\n");
  console.log(`wrote ${HISTORY_OUT} (${history.length} day${history.length === 1 ? "" : "s"})`);
}

process.exit(ok ? 0 : 0); // stale-but-rendering beats a dead refresh; failures are logged above
