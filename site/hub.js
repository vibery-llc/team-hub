/* Shared page behaviour for the hub. Mostly progressive enhancement — the one
   exception is the shell in section 0, which every page depends on. */

(() => {
  const esc = (t) =>
    String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* 0. The shell — header, nav and footer, from hub.config.js.

     These were identical on all six pages apart from which nav link carried
     `class="active"`, which meant the brand appeared in the markup six times
     and a nav change was a six-file edit. Now the pages ship an empty
     <header data-hub-shell> and <footer data-hub-shell> and this fills them,
     so "who this hub belongs to" lives in exactly one file.

     Which link is active comes from the URL rather than a per-page marker:
     one less thing for a new page to declare, and one less thing to get wrong.

     style.css reserves the header's height so filling it in does not shift the
     page. If hub.config.js is missing the shell is skipped and the rest of this
     file still runs — a hub with no header beats a hub with no lightbox, no
     folds and no agent buttons. */
  const CONFIG = globalThis.HUB_CONFIG || {};
  const allNav = Array.isArray(CONFIG.nav) ? CONFIG.nav : [];
  const featureEnabled = (feature) => {
    if (!feature) return true;
    if (feature === "activityLog") {
      const owner = CONFIG.activityLog?.owner;
      return CONFIG.activityLog?.enabled === true && typeof owner === "string" && Boolean(owner.trim());
    }
    return false;
  };
  const nav = allNav.filter((item) => featureEnabled(item.feature));

  // "/", "/index.html" and "/files.html" all have to resolve to a nav entry.
  const file = location.pathname.split("/").pop() || "index.html";
  const here = allNav.find((n) => n.href === file) || nav[0];

  /* 0c. Usage events — anonymous by default.

     Fire-and-forget POSTs to /api/event so a tenant can tell whether anyone
     but the person who set the hub up ever opens it or launches an agent
     from it. This never blocks: a slow, failing or 404ing endpoint (the
     Function is undeployed, or a local `python3 -m http.server` with no
     Functions at all — see CONTRIBUTING) must not delay a page or a launch,
     so the promise is never awaited by callers and errors are swallowed.

     Attribution is a tenant policy, not a product default — see README,
     "Usage stats". Off unless a human sets usageStats.attribution.enabled in
     hub.config.js, and even then this file never sends an identity: it only
     signals the choice, and the server reads the real identity itself off
     the Access header. */
  const usageAttrib = CONFIG.usageStats?.attribution || {};
  const USAGE_ATTRIBUTION = usageAttrib.enabled === true && Boolean(String(usageAttrib.owner || "").trim());
  window.kfLogEvent = (type, label, source) => {
    try {
      fetch("/api/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, label: label || "", source: source || "", attribute: USAGE_ATTRIBUTION }),
        keepalive: true,
      }).catch(() => { /* offline, undeployed, or blocked — never surfaced */ });
    } catch (e) { /* fetch unavailable — never block the caller */ }
  };
  window.kfLogEvent("page_view", (here && here.label) || file, file);

  if (nav.length) {
    document.title = here.title || `${here.label} — ${CONFIG.siteName || ""}`.replace(/ — $/, "");

    const header = document.querySelector("header[data-hub-shell]");
    if (header) {
      const b = CONFIG.brand || {};
      header.innerHTML = `
  <div class="site__brand">
    <img class="site__logo" src="brand/mark.png" width="${b.markWidth || ""}" height="${b.markHeight || ""}" alt="${esc(b.alt || CONFIG.org || "")}">
    <div class="site__title"><small>${esc(CONFIG.org || "")}</small>${esc(CONFIG.siteName || "")}</div>
  </div>
  <nav class="site__nav">${nav
    .map((n) => `<a href="${esc(n.href)}"${n === here ? ' class="active"' : ""}>${esc(n.label)}</a>`)
    .join("")}</nav>`;
    }

    const footer = document.querySelector("footer[data-hub-shell]");
    if (footer) footer.textContent = here.footer || CONFIG.footer || "";
  }

  /* 0b. Config values inside prose.

     Some pages need to name the project or the repo mid-sentence — the Setup
     walkthrough says "open your <project> folder" a dozen times. Without this
     those pages would have to be tenant-owned copies, which is a lot of
     duplication to carry for one proper noun.

     <em data-hub-var="projectName"></em> anywhere in a page gets the value from
     hub.config.js. Dotted paths work, so data-hub-var="repo.slug" resolves too.
     An unset key leaves whatever the page already had, so the markup can hold a
     sensible default and still read correctly if the config omits it. */
  const lookup = (path) =>
    String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), CONFIG);

  for (const el of document.querySelectorAll("[data-hub-var]")) {
    const value = lookup(el.dataset.hubVar);
    if (value != null && value !== "") el.textContent = value;
  }

  /* 1. Publish the scrollbar width as --sbw.

     style.css breaks the epic timeline out of the 1080px column using 100vw.
     On a page with a vertical scrollbar, 100vw is wider than the document by
     exactly the scrollbar, which would push a horizontal scrollbar onto <body>
     — the thing that breakout exists to remove. Subtracting --sbw cancels it.
     The CSS defaults to 0px, so a failure here costs a few pixels, not a
     broken layout. */
  const setScrollbarWidth = () => {
    const w = window.innerWidth - document.documentElement.clientWidth;
    document.documentElement.style.setProperty("--sbw", `${Math.max(0, w)}px`);
  };
  setScrollbarWidth();
  window.addEventListener("resize", setScrollbarWidth, { passive: true });

  /* 2. Send off-site links to a new tab.

     The visible ↗ marker is pure CSS (`a[href^="http"]::after`) so it is
     correct on first paint. This only adds the matching behaviour, and skips
     anything that already declares a target so an explicit choice always wins.
     `rel` blocks the opened page from reaching back through window.opener. */
  const markExternal = (root) => {
    for (const a of root.querySelectorAll('a[href^="http"]:not([target])')) {
      if (a.host && a.host !== location.host) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
    }
  };
  markExternal(document);

  /* 3. The agent launcher.

     Lifted out of index.html so it is not the dashboard's private property: the
     meetings page launches sessions off its action items with the same engine,
     honouring the same saved preference. One list of launchers, one set of URL
     schemes, one place to fix a broken one.

     Every launcher below only PRE-FILLS a prompt box — none of them send. That
     is the documented behaviour of all three URL schemes, and it is why it is
     safe to put a one-click launcher on a web page at all: the worst a bad link
     can do is put text in front of you.

     "Copy prompt" is the universal fallback. It needs no protocol handler, works
     with any agent on any OS, and sidesteps shell-quoting a multi-line string. */
  const REPO_SLUG = (CONFIG.repo || {}).slug || "";
  const REPO_GIT_URL = (CONFIG.repo || {}).gitUrl || "";
  const MAX_URL_PROMPT = 4500; // claude-cli caps `q` at 5000; leave headroom for the rest of the URL

  const LAUNCHERS = [
    {
      id: "claude-terminal", label: "Claude Code", note: "opens a terminal session",
      // `repo` resolves to whichever clone you last ran claude in, so one link works for everyone.
      url: (p) => `claude-cli://open?repo=${encodeURIComponent(REPO_SLUG)}&q=${encodeURIComponent(p)}`,
    },
    {
      // The Claude desktop app registers claude:// but exposes no route that accepts a
      // folder and a prompt — only claude://claude, /resume and /cowork/shared-artifact.
      // So: copy first (always works), then bring the app forward. If the scheme ever
      // stops resolving, the prompt is still on the clipboard and the button said so.
      id: "claude-desktop", label: "Claude desktop", note: "copies the prompt, then opens the app — paste it in",
      url: null, launch: "claude://claude", copies: true,
    },
    {
      id: "claude-vscode", label: "Claude in VS Code", note: "opens a tab in your focused window",
      url: (p) => `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(p)}`,
    },
    {
      // codex:// is claimed by the ChatGPT desktop app, so this IS the desktop path.
      id: "codex", label: "Codex desktop", note: "opens the ChatGPT app, workspace matched by git remote",
      url: (p) => `codex://threads/new?originUrl=${encodeURIComponent(REPO_GIT_URL)}&prompt=${encodeURIComponent(p)}`,
    },
    /* Anything your team uses that isn't one of the above goes in
       hub.config.js under `launchers` — see just below. */
    ...(CONFIG.launchers || []).map((l) => ({
      id: l.id,
      label: l.label,
      note: l.note || "",
      launch: l.launch || null,
      copies: Boolean(l.copies),
      /* A config launcher declares `urlTemplate` with a {prompt} placeholder
         rather than a function, so the config file stays data. No template
         means the clipboard, which is the right answer for any tool without a
         documented deep link — most of them. */
      url: l.urlTemplate
        ? (p) => l.urlTemplate.replace("{prompt}", encodeURIComponent(p))
        : null,
    })),
    /* Always last, and always present: it needs no protocol handler, works with
       any agent on any OS, and is the fallback every other entry degrades to. */
    { id: "copy", label: "Copy prompt", note: "paste into anything — Cursor, a CLI, whatever", url: null },
  ];

  function currentLauncher() {
    let saved = null;
    try { saved = localStorage.getItem("kfhub.launcher"); } catch (e) { /* private mode */ }
    if (LAUNCHERS.some((l) => l.id === saved)) return saved;
    // Seed from the agent AND client they picked on Setup, so the two pages agree.
    let agent = null, clients = {};
    try {
      agent = localStorage.getItem("kfhub.agent");
      clients = JSON.parse(localStorage.getItem("kfhub.client")) || {};
    } catch (e) { /* private mode, or an older string-shaped value */ }
    if (agent === "codex") return "codex";
    // Cursor has no documented prompt deep link, and "other" is by definition unknown —
    // the clipboard is the launcher that works for both.
    if (agent === "cursor" || agent === "other") return "copy";
    if (clients.claude === "desktop") return "claude-desktop";
    if (clients.claude === "vscode") return "claude-vscode";
    if (clients.claude === "web") return "copy";
    return "claude-terminal"; // terminal, and Rider (where you run claude in its terminal)
  }

  window.KF_LAUNCHERS = LAUNCHERS;
  window.kfCurrentLauncher = currentLauncher;
  window.kfSetLauncher = (id) => {
    try { localStorage.setItem("kfhub.launcher", id); } catch (e) { /* private mode */ }
  };

  /* Hands `prompt` to whichever launcher is selected and resolves to the status
     the caller should show on its button. `source` records where the click came
     from — a ticket key, or a meeting action item.

     Clipboard first, app second: if a URL scheme silently fails to resolve, the
     prompt is still in hand and the button has already said so. */
  window.kfLaunchAgent = async ({ prompt, label, source } = {}) => {
    if (!prompt) return "nothing to send";
    const launcher = LAUNCHERS.find((l) => l.id === currentLauncher())
      || LAUNCHERS[LAUNCHERS.length - 1];

    // Fire-and-forget: never awaited, so a slow or failing event POST cannot
    // delay the launch it is merely recording.
    window.kfLogEvent("agent_launch", launcher.id, source || "");

    // Oversized prompts can't ride in a URL — degrade rather than truncate.
    if (!launcher.url || prompt.length > MAX_URL_PROMPT) {
      let copied = true;
      try { await navigator.clipboard.writeText(prompt); }
      catch (e) { copied = false; window.prompt("Copy this prompt:", prompt); }
      if (launcher.launch) {
        window.location.href = launcher.launch;
        return copied ? "Copied — paste it in" : "Opening…";
      }
      return copied ? "Copied" : "Copy it above";
    }
    window.location.href = launcher.url(prompt);
    return "Opening…";
  };


  /* 4. The lightbox.

     Both the dashboard and the Files page show proof shots, so the viewer lives
     here rather than being copy-pasted into each. Any <img data-lightbox> opens
     it; the overlay is created on first use so pages that never show an image
     carry no extra markup. */
  let box = null;
  const openLightbox = (src, alt) => {
    if (!box) {
      box = document.createElement("div");
      box.className = "lightbox";
      box.innerHTML = '<img alt="">';
      box.addEventListener("click", () => box.classList.remove("is-open"));
      document.body.appendChild(box);
    }
    const img = box.firstElementChild;
    img.src = src;
    img.alt = alt || "";
    box.classList.add("is-open");
  };

  document.addEventListener("click", (e) => {
    const img = e.target.closest("img[data-lightbox]");
    if (img) openLightbox(img.dataset.lightbox || img.currentSrc || img.src, img.alt);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && box) box.classList.remove("is-open");
  });


  /* 5. Collapsible sections.

     Remembers whether each one was left open, so a teammate who always wants
     PRs expanded gets that on every visit. And a jump link pointing into a
     closed section opens it — otherwise the link scrolls to a shut bar and
     looks broken. */
  const foldKey = (f) => "kfhub.fold." + f.dataset.fold;
  for (const f of document.querySelectorAll("details[data-fold]")) {
    try {
      const saved = localStorage.getItem(foldKey(f));
      if (saved !== null) f.open = saved === "1";
    } catch (e) { /* private mode */ }
    f.addEventListener("toggle", () => {
      try { localStorage.setItem(foldKey(f), f.open ? "1" : "0"); } catch (e) { /* private mode */ }
    });
  }

  const openHashFold = () => {
    if (!location.hash || location.hash.length < 2) return;
    let target = null;
    try { target = document.querySelector(location.hash); } catch (e) { return; }
    const fold = target && target.closest("details[data-fold]");
    if (fold && !fold.open) fold.open = true;
  };
  openHashFold();
  window.addEventListener("hashchange", openHashFold);

  /* 6. Unity Editor + player semver — only for teams whose project is a
     Unity game, which is what a `game` block in hub.config.js declares.

     Setup and Files mount an empty [data-hub-unity] node inside a hidden
     [data-hub-unity-section] wrapper. We paint first from hub.config.js
     `game` (may be a day stale) then overlay data.json `project` from the
     last fetch-data run against the game repo. Without a `game` config the
     whole thing is skipped — nothing paints, no extra data.json request,
     and the wrappers stay hidden, so a hub for a non-Unity team never
     shows an empty Unity heading. */
  const unityLinks = (game) => {
    const v = game?.unity?.editorVersion || "";
    const c = game?.unity?.changeset || "";
    return {
      version: v,
      changeset: c,
      hubUri: game?.unity?.hubUri || (v && c ? `unityhub://${v}/${c}` : v ? `unityhub://${v}` : ""),
      downloadUrl: game?.unity?.downloadUrl || (v ? `https://unity.com/releases/editor/whats-new/${v}` : "https://unity.com/releases/editor/archive"),
      archiveUrl: game?.unity?.archiveUrl || "https://unity.com/releases/editor/archive",
      hubApp: "https://unity.com/download",
      semver: game?.app?.semver || "",
      source: game?.app?.source || "PlayerSettings.bundleVersion",
      ref: game?.ref || "",
    };
  };

  const paintUnity = (game) => {
    const L = unityLinks(game);
    if (!L.version) return;
    const html = `
      <div class="build unity-install">
        <div class="build__tag">Unity Editor</div>
        <div class="build__name">${esc(L.version)}</div>
        <div class="build__meta">this project · player v${esc(L.semver || "—")} (${esc(L.source)})
          ${L.ref ? `<br>read from <code>${esc(L.ref)}</code>` : ""}
          ${L.changeset ? `<br>changeset ${esc(L.changeset)}` : ""}</div>
        <div class="btn-row m-0">
          ${L.hubUri ? `<a class="btn btn--primary" href="${esc(L.hubUri)}">Open in Unity Hub</a>` : ""}
          <a class="btn btn--ghost" href="${esc(L.downloadUrl)}">Download this version</a>
          <a class="btn btn--ghost" href="${esc(L.archiveUrl)}">Editor archive</a>
          <a class="btn btn--ghost" href="${esc(L.hubApp)}">Get Unity Hub</a>
        </div>
      </div>`;
    for (const el of document.querySelectorAll("[data-hub-unity]")) {
      el.innerHTML = html;
      /* The first paint runs before the MutationObserver below exists, so
         mark the card's off-site links by hand. */
      markExternal(el);
    }
    for (const el of document.querySelectorAll("[data-hub-unity-section]")) el.hidden = false;
  };

  if (CONFIG.game) {
    paintUnity(CONFIG.game);
    fetch("data.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.project) return;
        paintUnity({
          ref: d.project.ref || CONFIG.game.ref,
          unity: { ...(CONFIG.game.unity || {}), ...(d.project.unity || {}) },
          app: { ...(CONFIG.game.app || {}), ...(d.project.app || {}) },
        });
      })
      .catch(() => { /* local preview without data.json is fine */ });
  }

  /* The dashboard, meetings and files pages build their links from fetched
     JSON after this runs, so watch for nodes arriving later. */
  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType === 1) markExternal(node.parentNode || node);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
