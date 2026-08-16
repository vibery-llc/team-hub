#!/usr/bin/env node
/**
 * First-run setup for a new hub.
 *
 * What this does and does not do, deliberately:
 *
 *   It does the plumbing that is fiddly and easy to get subtly wrong — the
 *   Pages project, the R2 bucket, the binding names in wrangler.toml, the
 *   GitHub secrets — and it prints the exact Cloudflare Access steps, which
 *   cannot be scripted because they are dashboard-only.
 *
 *   It does NOT try to write your whole hub.config.js. That file is one
 *   commented file you are meant to read, and a generator that rewrites it
 *   would either destroy the comments or guess at links it cannot know. It
 *   fills in the few unambiguous identity fields and then tells you to open it.
 *
 * Usage:
 *   node scripts/init.mjs                 interactive
 *   node scripts/init.mjs --dry-run       print what would happen, touch nothing
 *
 *   node scripts/init.mjs --yes \         non-interactive
 *     --org="Northwind Labs" --project=Atlas --repo=northwind-labs/atlas \
 *     --hub=atlas-hub [--site="Atlas — Team Hub"]
 *
 * Any flag you pass is used without asking. --yes answers every remaining
 * prompt with its default and never blocks, which is what makes this runnable
 * from CI or a provisioning script rather than only by hand.
 *
 * Nothing here is destructive without saying so first, and every external
 * command is printed before it runs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");

const CONFIG_PATH = join(ROOT, "site", "hub.config.js");
const WRANGLER_PATH = join(ROOT, "wrangler.toml");

/* The example identity that ships in the repo. init replaces exactly these
   strings, which is why they are listed once here rather than inlined. */
const EXAMPLE = {
  org: "Northwind Labs",
  siteName: "Atlas — Team Hub",
  projectName: "Atlas",
  repoDirName: "atlas",
  repoSlug: "northwind-labs/atlas",
  brandAlt: "Northwind Labs",
  hubName: "team-hub",
  bucket: "team-hub-files",
};

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function run(cmd, args, { optional = false } = {}) {
  console.log(dim(`  $ ${cmd} ${args.join(" ")}`));
  if (DRY) return "";
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const msg = (err.stderr || err.message || "").trim().split("\n")[0];
    if (optional) {
      console.log(yellow(`  ! skipped: ${msg}`));
      return null;
    }
    throw new Error(`${cmd} failed: ${msg}`);
  }
}

const has = (cmd) => {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/* A hub name becomes a Cloudflare Pages project name and an R2 bucket name,
   both of which are stricter than a display name: lowercase, alphanumeric and
   dashes, no leading or trailing dash. Fail early rather than at deploy. */
const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 58);

/* --key=value flags, so every prompt has a non-interactive answer. */
const FLAGS = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith("--") && a.includes("="))
    .map((a) => [a.slice(2, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]),
);
const YES = process.argv.includes("--yes");

/* Only open a readline when something will actually be asked. Holding one open
   under --yes keeps the process alive after the last line is printed. */
const interactive = !YES || Object.keys(FLAGS).length === 0;
const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;

const ask = async (question, fallback, flag) => {
  if (flag && FLAGS[flag] !== undefined) {
    console.log(`${question} ${dim(FLAGS[flag] + "  (--" + flag + ")")}`);
    return FLAGS[flag];
  }
  if (YES) {
    console.log(`${question} ${dim((fallback || "") + "  (--yes)")}`);
    return fallback || "";
  }
  const answer = (await rl.question(`${question}${fallback ? dim(` [${fallback}]`) : ""} `)).trim();
  return answer || fallback || "";
};

/* --yes means "do not block", not "say yes to everything".

   A review gate ("does this look right?") passes under --yes, because the
   caller supplied the values on the command line and re-confirming them to
   nobody is theatre. Anything that creates a cloud resource defaults to NO and
   has to be opted into explicitly with its own flag, so an unattended run can
   never quietly provision infrastructure. */
const confirm = async (question, { flag, underYes = false } = {}) => {
  if (flag && FLAGS[flag] !== undefined) return /^(1|y|yes|true)$/i.test(FLAGS[flag]);
  if (YES) {
    console.log(`${question} ${dim((underYes ? "yes" : "no") + "  (--yes)")}`);
    return underYes;
  }
  return /^y(es)?$/i.test((await ask(`${question} ${dim("(y/N)")}`, "")) || "n");
};

console.log(bold("\n  team-hub — first run\n"));
if (DRY) console.log(yellow("  --dry-run: nothing will be written or created.\n"));

const org = await ask("Organisation or team name, as it appears above the title:", EXAMPLE.org, "org");
const projectName = await ask("Project name, used mid-sentence on the Setup page:", EXAMPLE.projectName, "project");
const siteName = await ask("Site title:", `${projectName} — Team Hub`, "site");
const repoSlug = await ask("The repo your team works in (owner/name):", EXAMPLE.repoSlug, "repo");
const hubName = slug(await ask("Short name for this hub (Pages project + R2 bucket prefix):", slug(`${projectName}-hub`), "hub"));

if (!hubName) {
  console.error("\n  A hub name is required — it names the Pages project and the R2 bucket.\n");
  if (rl) rl.close();
  process.exit(1);
}
const bucket = `${hubName}-files`;
const repoDirName = repoSlug.split("/").pop();

console.log(`
  ${bold("About to configure")}
    hub name .......... ${hubName}
    Pages project ..... ${hubName}
    R2 bucket ......... ${bucket}
    team repo ......... ${repoSlug}
`);

if (!(await confirm("Look right?", { underYes: true }))) {
  console.log("\n  Nothing changed.\n");
  if (rl) rl.close();
  process.exit(0);
}

/* ---- 1. identity into the two config files ------------------------------- */

console.log(bold("\n  1. Writing configuration"));

const replaceAll = (text, pairs) =>
  pairs.reduce((acc, [from, to]) => acc.split(from).join(to), text);

/* Order matters: the longest, most specific strings go first, so that
   "Atlas — Team Hub" is consumed before the bare "— Atlas" pass reaches it. */
const configText = replaceAll(readFileSync(CONFIG_PATH, "utf8"), [
  [EXAMPLE.siteName, siteName],
  [EXAMPLE.brandAlt, org],
  [EXAMPLE.org, org],
  [EXAMPLE.repoSlug, repoSlug],
  // Per-page tab titles: "Meetings — Atlas" -> "Meetings — Fathom".
  [`— ${EXAMPLE.projectName}"`, `— ${projectName}"`],
  [`GitHub · ${EXAMPLE.repoDirName}`, `GitHub · ${repoDirName}`],
  [`projectName: "${EXAMPLE.projectName}"`, `projectName: "${projectName}"`],
  [`repoDirName: "${EXAMPLE.repoDirName}"`, `repoDirName: "${repoDirName}"`],
]);

const wranglerText = replaceAll(readFileSync(WRANGLER_PATH, "utf8"), [
  [`name = "${EXAMPLE.hubName}"`, `name = "${hubName}"`],
  [`HUB_NAME = "${EXAMPLE.hubName}"`, `HUB_NAME = "${hubName}"`],
  [`bucket_name = "${EXAMPLE.bucket}"`, `bucket_name = "${bucket}"`],
]);

if (DRY) {
  console.log(dim("  would rewrite site/hub.config.js and wrangler.toml"));
} else {
  writeFileSync(CONFIG_PATH, configText);
  writeFileSync(WRANGLER_PATH, wranglerText);
  console.log(green("  ✓ site/hub.config.js"));
  console.log(green("  ✓ wrangler.toml"));
}

/* ---- 2. Cloudflare ------------------------------------------------------- */

console.log(bold("\n  2. Cloudflare"));

if (!has("wrangler") && !has("npx")) {
  console.log(yellow("  ! Neither wrangler nor npx found — skipping. Install wrangler and re-run, or"));
  console.log(yellow("    create the project and bucket by hand; the commands are in the README."));
} else if (await confirm("  Create the Pages project and R2 bucket now?", { flag: "create-resources" })) {
  const wrangler = has("wrangler") ? ["wrangler", []] : ["npx", ["-y", "wrangler"]];
  const [cmd, prefix] = wrangler;
  // Both are safe to re-run: an existing project or bucket just reports so.
  run(cmd, [...prefix, "pages", "project", "create", hubName, "--production-branch", "main"], { optional: true });
  run(cmd, [...prefix, "r2", "bucket", "create", bucket], { optional: true });
} else {
  console.log(dim("  skipped"));
}

/* ---- 3. repo secrets ----------------------------------------------------- */

console.log(bold("\n  3. GitHub secrets"));

const SECRETS = [
  ["CLOUDFLARE_API_TOKEN", "Cloudflare token with the Cloudflare Pages: Edit permission"],
  ["CLOUDFLARE_ACCOUNT_ID", "from the Cloudflare dashboard sidebar"],
  ["GH_PAT", `fine-grained PAT, read-only on ${repoSlug} (Contents + Pull requests + Metadata) — used for dashboard data and, on the scheduled refresh, mirroring proof screenshots out of PR bodies`],
  ["JIRA_EMAIL", "Atlassian account email — skip if you have no tracker"],
  ["JIRA_TOKEN", "Atlassian API token — skip if you have no tracker"],
];

if (!has("gh")) {
  console.log(yellow("  ! gh CLI not found. Set these under Settings → Secrets → Actions:"));
  for (const [name, why] of SECRETS) console.log(`      ${name.padEnd(22)} ${dim(why)}`);
} else {
  console.log(dim("  Leave any of these blank to skip it.\n"));
  for (const [name, why] of SECRETS) {
    console.log(`  ${bold(name)} ${dim(`— ${why}`)}`);
    const value = await ask("    value:", "");
    if (!value) {
      console.log(dim("    skipped"));
      continue;
    }
    if (DRY) {
      console.log(dim(`    would run: gh secret set ${name}`));
      continue;
    }
    try {
      execFileSync("gh", ["secret", "set", name], { input: value, stdio: ["pipe", "ignore", "pipe"] });
      console.log(green(`    ✓ ${name} set`));
    } catch (err) {
      console.log(yellow(`    ! could not set ${name}: ${(err.stderr || "").toString().trim().split("\n")[0]}`));
    }
  }
}

/* ---- 4. the part that cannot be scripted --------------------------------- */

console.log(`
${bold("  4. Cloudflare Access — do this by hand")}

  Access is what makes the hub private, and it is dashboard-only. Until it is
  configured your hub is ${yellow("publicly readable")}, so do this before you put
  anything real in it.

    a. Zero Trust → Access → Applications → Add a self-hosted application.
    b. Cover ${bold(`${hubName}.pages.dev`)} AND ${bold(`*.${hubName}.pages.dev`)}.
       Preview deploys live on the wildcard; an app covering only the apex
       leaves every preview URL wide open.
    c. Add a policy allowing the email addresses on your team.
    d. For agents: Access → Service Auth → create a service token, then add it
       to the same application's policy with Action: Service Auth. That is what
       lets the MCP endpoint in functions/mcp/ authenticate.

${bold("  5. Still the example's — init cannot guess these")}

  In ${bold("site/hub.config.js")}, still pointing at the fictional example team:

    ${yellow("tracker")} ....... board URL and project key, or ${bold("null")} to run on GitHub alone
    ${yellow("phases")} ........ which ticket stands for each phase of your plan
    ${yellow("links")} ......... the Links fold on the dashboard
    ${yellow("prompts")} ....... the prompt buttons — these encode YOUR harness and gates,
                    and are worth rewriting rather than tweaking
    ${yellow("activityLog")} ... optional; a human must enable it and name its owner
    ${yellow("footer")} ........ the line at the bottom of every page

${bold("  6. Then")}

    ${dim("# check it renders before you wire up credentials")}
    npx wrangler pages dev

    ${dim("# fill in the rest — see the list above")}
    $EDITOR site/hub.config.js

    ${dim("# swap the placeholder mark for yours (mark.png, mark-32.png, mark-64.png)")}
    ls site/brand/

    ${dim("# replace the example meeting with a real one, or delete it")}
    ls site/meetings/

  Push to main and the workflow deploys. ${green("Done.")}
`);

if (rl) rl.close();
