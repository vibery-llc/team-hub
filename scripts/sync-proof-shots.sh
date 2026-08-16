#!/usr/bin/env bash
# Mirror proof screenshots out of PR bodies into site/img/proof/.
#
# Why mirror instead of hotlink: if your repo is private, a GitHub raw URL 404s
# for anyone whose browser isn't authenticated against it — which is every
# teammate reading this hub. Copies here are served through Cloudflare Access
# like the rest of the site.
#
# Shots are small (a few hundred KB), so they live in git alongside the site.
# Anything big belongs in R2 via the Files page, not here.
#
# Usage: scripts/sync-proof-shots.sh [pr-limit]     (default 40)

set -euo pipefail

LIMIT="${1:-40}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/site/img/proof"

# Which repo to read. Defaults to repo.slug in site/hub.config.js — resolved
# from ROOT, not the caller's cwd, so this works from anywhere. A tenant with
# no repo configured (or an empty slug) is a clean no-op, not an error: not
# every fork wires this up, and the caller (the refresh workflow) needs to be
# able to tell "nothing to do" apart from "something failed".
REPO="${PROOF_REPO:-$(node -e '
  require(process.argv[1]);
  const slug = globalThis.HUB_CONFIG && globalThis.HUB_CONFIG.repo && globalThis.HUB_CONFIG.repo.slug;
  process.stdout.write(slug || "");
' "$ROOT/site/hub.config.js")}"

if [ -z "$REPO" ]; then
  echo "no source repo configured (repo.slug in site/hub.config.js) — skipping proof screenshot sync"
  exit 0
fi

command -v gh >/dev/null || { echo "gh CLI not found — https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh not authenticated — run: gh auth login, or set GH_TOKEN" >&2; exit 1; }

mkdir -p "$DEST"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# One line per image: pr<TAB>date<TAB>prTitle<TAB>sha<TAB>path
gh pr list --repo "$REPO" --state all --limit "$LIMIT" \
  --json number,title,mergedAt,updatedAt,body \
  --jq '
    .[]
    | select(.body != null)
    | . as $p
    | ($p.body | [scan("/raw/([a-f0-9]{40})/(proof/[^ )\"\\]]+)")])
    | select(length > 0)
    | .[]
    | [$p.number, ($p.mergedAt // $p.updatedAt), ($p.title | gsub("\t"; " ")), .[0], .[1]]
    | @tsv
  ' > "$tmp"

count=0
entries=""

while IFS=$'\t' read -r pr date prtitle sha path; do
  [ -z "${sha:-}" ] && continue
  rel="${path#proof/}"                      # e.g. app-142/connect-after.png
  out="$DEST/$rel"
  mkdir -p "$(dirname "$out")"

  if [ -s "$out" ]; then
    echo "skip  $rel (already mirrored)"
  elif gh api "repos/$REPO/contents/$path?ref=$sha" \
         -H "Accept: application/vnd.github.raw" > "$out" 2>/dev/null; then
    echo "get   $rel"
  else
    echo "FAIL  $rel" >&2
    rm -f "$out"
    continue
  fi

  ticket="$(dirname "$rel")"
  # Ticket-shaped folder names get uppercased: app-142 -> APP-142. Anything
  # else keeps its shape with dashes as spaces.
  if printf '%s' "$ticket" | grep -qiE '^[a-z][a-z0-9]*-[0-9]+$'; then
    ticket="$(printf '%s' "$ticket" | tr '[:lower:]' '[:upper:]')"
  else
    ticket="$(printf '%s' "$ticket" | tr '-' ' ')"
  fi

  base="$(basename "$rel")"
  title="$(printf '%s' "${base%.*}" | tr '-_' '  ')"
  title="$(printf '%s' "$title" | awk '{ $1=toupper(substr($1,1,1)) substr($1,2); print }')"

  esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
  entries="$entries$(cat <<JSON
    {
      "file": "$(esc "$rel")",
      "title": "$(esc "$title")",
      "ticket": "$(esc "$ticket")",
      "pr": $pr,
      "prUrl": "https://github.com/$REPO/pull/$pr",
      "prTitle": "$(esc "$prtitle")",
      "date": "$(esc "$date")"
    },
JSON
)
"
  count=$((count + 1))
done < "$tmp"

if [ "$count" -eq 0 ]; then
  echo "no proof images found in the last $LIMIT PRs" >&2
  exit 0
fi

{
  printf '{\n'
  printf '  "note": "Mirrored from PR bodies. Regenerate with scripts/sync-proof-shots.sh.",\n'
  printf '  "syncedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "shots": [\n'
  printf '%s' "$entries" | sed '$ s/,$//'
  printf '  ]\n}\n'
} > "$DEST/manifest.json"

echo
echo "$count shot(s) in $DEST — manifest.json rewritten"
