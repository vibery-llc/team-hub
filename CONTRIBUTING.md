# Contributing

Thanks for looking. This is a small project with a few strong opinions, and the
opinions are most of what makes it useful — so it's worth knowing them before
you spend time on a change.

## The constraints, and why they are not negotiable

**No build step.** No bundler, no `node_modules` to deploy, no generated output.
`site/` is what ships. You can open `site/index.html` behind any static server
and see the real thing. A dependency that needs compiling takes that away, and
takes with it the property that anyone can fix this hub without knowing the
toolchain. Node is used by `scripts/`, never by the site.

**No framework.** The pages are HTML with a little JavaScript at the bottom. If
a change would be easier with a framework, that is a signal the change is too
big, not that the rule is wrong.

**One button, one callout.** `.btn` with size and tone modifiers, and one
callout family. This started as three parallel button systems and it made the
pages feel like three different sites. New visual components need a reason that
survives being asked "could this be a `.btn`?"

**No inline styles.** If you need a value that does not exist, add it to
`style.css` as a token.

**Product code names no tenant.** `hub.js`, `style.css`, the Functions and the
three data-driven pages must not mention a specific company, repo or board.
Anything team-specific belongs in `site/hub.config.js` or `site/brand/`. This is
what lets a deployment pull upstream changes without conflicts, and it is easy
to check:

```bash
grep -rniE 'your-org|your-repo' site/hub.js site/index.html site/meetings.html site/files.html site/feedback.html
```

## Things that will bite you

These are load-bearing and each one cost somebody a debugging session:

- **Functions live in `functions/` at the project root**, not inside `site/`.
  With `pages_build_output_dir` set, Pages discovers Functions beside
  `wrangler.toml`, and a `functions/` folder inside the output directory is
  silently ignored — the deploy goes green and every API route 404s.
- **`wrangler pages deploy` takes no directory argument** once
  `pages_build_output_dir` is set. Passing `site` as well is an error.
- **Preview needs its own bindings.** A binding declared only for production
  leaves every preview URL answering 503.
- **`hub.js` and `style.css` are served `no-cache`** via `site/_headers` so the
  browser revalidates. Do not reintroduce `?v=N` — that was the old scheme and
  forgetting to bump it shipped a hub where every agent button silently did
  nothing.
- **R2 `list()` omits `httpMetadata`/`customMetadata`** unless `include` asks
  for them.
- **`requestAnimationFrame` does not run in a background tab.** The KPI count-up
  checks `visibilityState` for exactly this reason — without it, opening the hub
  in a background tab shows zeros forever.
- **`hub.js` is deferred**, so a small or cached JSON fetch can resolve before
  it runs. Anything that needs `window.kfLaunchAgent` must await the
  `hubReady` promise first, or the agent buttons vanish with no error.

## Working on it

```bash
git clone https://github.com/vibery-llc/team-hub
cd team-hub
python3 -m http.server 8080 -d site      # open http://localhost:8080
```

That is enough for everything except the Functions. For those:

```bash
npx wrangler pages dev
```

The repo ships with a fictional example team (Northwind Labs / Atlas) so a fresh
clone renders a complete hub — a populated dashboard, an example meeting with a
transcript, a placeholder brand mark. **Please do not "fix" the example data to
look like your team.**

## Pull requests

- One change per PR. A PR that also reformats is two PRs.
- Say what you verified, and how. "Loaded every page, no console errors" is
  worth more than "should work" — this project has no test suite, so the PR body
  is the evidence.
- Screenshots for anything visual, in both light and dark. The palette is
  defined twice and it is easy to change one and not the other.
- Comments should explain **why**, not what. The existing code is written this
  way; matching it matters more than your personal preference about comments.

## Things that would genuinely help

- A tracker adapter that is not Jira. `scripts/fetch-data.mjs` reads
  `tracker.kind` and currently implements one; the seam is there and unproven.
- Accessibility review. The pages use native `<details>`, real buttons and
  sensible headings, but nobody has run a screen reader end to end.
- Security headers in `site/_headers`. A CSP needs thought against the inline
  page scripts and the Google Fonts link, which is why it is not there already.

## Reporting something sensitive

If you find a way to read another tenant's files, bypass the Access gate, or
escape the key validation in `functions/api/`, please open a private security
advisory on the repo rather than a public issue.
