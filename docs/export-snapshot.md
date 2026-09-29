# Exporting Pipeline Scoreboard Snapshots

The pipeline scoreboard snapshot can be exported to standalone HTML, PNG, and PDF formats for sharing, archiving, or use in skills and automation.

**Canonical export script**: `scripts/snapshot-to-png.mjs` (adapted from `scoreboard-pilots/2026-09-29/render-png.mjs`). Hub UI and skill export share the same HTML→bytes path so live board and exports match.

## Export to HTML

A standalone HTML file embeds the scoreboard with all styles, making it portable and viewable without the full team hub.

### Manual export

1. Open the dashboard with scoreboard enabled
2. Open browser DevTools (F12)
3. Run in console:

```javascript
// Extract scoreboard section
const scoreboard = document.getElementById('pipeline-scoreboard');
const styles = document.querySelector('link[href="style.css"]');

// Build standalone HTML
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pipeline Scoreboard</title>
<style>
/* Paste full style.css content or inline critical styles */
</style>
</head>
<body style="padding: 40px; background: #faf6f0;">
${scoreboard.outerHTML}
</body>
</html>`;

// Download
const blob = new Blob([html], { type: 'text/html' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'scoreboard-' + new Date().toISOString().slice(0,10) + '.html';
a.click();
```

### Script-based export (recommended)

Create a simple export script using the hub's existing snapshot.json:

```bash
# scripts/export-scoreboard.sh
#!/bin/bash
# Reads snapshot.json and generates standalone HTML with embedded styles

SNAPSHOT="site/snapshot.json"
STYLES="site/style.css"
OUTPUT="scoreboard-$(date +%Y-%m-%d).html"

# Basic template (expand as needed)
cat > "$OUTPUT" <<EOF
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Pipeline Scoreboard</title>
<style>
$(cat "$STYLES" | grep -A 200 'pipeline scoreboard')
</style>
</head>
<body>
<!-- Add rendering logic here -->
</body>
</html>
EOF

echo "Exported to $OUTPUT"
```

For production use, consider a Node.js script that:
1. Reads `snapshot.json`
2. Renders gauges server-side
3. Inlines critical CSS
4. Outputs standalone HTML

## Theme compatibility

The export script loads theme packs from `site/themes/<board-id>.json` to apply brand tokens. When exporting:

1. Snapshot `board` field determines which theme loads
2. Theme `brand.*` properties map to CSS custom properties (`--sb-*`)
3. Shared chip colors: PASS `#1a7f37`, WAIT `#9a6700`, FAIL `#cf222e`
4. Missing logos fall back to text title + `brand.primary`

Theme packs are optional. Without a theme, the scoreboard uses hub defaults.

**Known logo gaps** (do not block export):
- CoS: `logo: null` — text title used
- Vibery: PNG pending #1512 — use text title until landed
- Compass: PNG TBD — use text title until confirmed

## Export to PNG

PNG export requires rendering the HTML to an image. Two common approaches:

### Using Puppeteer (Node.js)

**Canonical implementation**: `scripts/snapshot-to-png.mjs` (source: `scoreboard-pilots/2026-09-29/render-png.mjs`)

```javascript
// scripts/snapshot-to-png.js
// Adapted from scoreboard-pilots/render-png.mjs pilot implementation
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function exportSnapshotToPNG(snapshotPath, outputPath, options = {}) {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  // Set viewport for consistent sizing (adjust per your needs)
  await page.setViewport({ 
    width: options.width || 1200, 
    height: options.height || 800,
    deviceScaleFactor: 2  // 2x for Retina/high-DPI
  });
  
  // Option 1: Load live hub URL (requires running server)
  // await page.goto('http://localhost:8080/', { waitUntil: 'networkidle0' });
  
  // Option 2: Load generated standalone HTML file
  const htmlPath = 'file://' + path.resolve(options.htmlPath || 'scoreboard.html');
  await page.goto(htmlPath, { waitUntil: 'networkidle0' });
  
  // Wait for scoreboard to render
  await page.waitForSelector('#pipeline-scoreboard:not([hidden])');
  
  // Take screenshot of just the scoreboard section
  const element = await page.$('#pipeline-scoreboard');
  if (!element) {
    throw new Error('Scoreboard element not found - check that it rendered');
  }
  
  await element.screenshot({
    path: outputPath,
    omitBackground: false
  });
  
  await browser.close();
  console.log(`✓ Exported to ${outputPath}`);
  
  return {
    board: snapshot.board,
    asOf: snapshot.as_of,
    score: snapshot.score,
    outputPath
  };
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const [snapshotPath, outputPath] = process.argv.slice(2);
  exportSnapshotToPNG(
    snapshotPath || 'site/snapshot.json',
    outputPath || 'scoreboard.png'
  ).catch(err => {
    console.error('Export failed:', err.message);
    process.exit(1);
  });
}

module.exports = { exportSnapshotToPNG };
```

Install and run:

```bash
npm install puppeteer-core
node scripts/snapshot-to-png.mjs site/snapshot.json output.png
```

**PDF export**: Use the same script with `--pdf` flag:

```bash
node scripts/snapshot-to-png.mjs site/snapshot.json --pdf
# Generates both scoreboard.png and scoreboard.pdf
```

PDF uses the same Chromium session with `page.pdf({ printBackground: true, preferCSSPageSize: true })`. The `@media print` styles in `style.css` preserve chip colors and layout.

### Using CLI tools

For simpler setups without Node.js dependencies:

**wkhtmltoimage** (cross-platform):

```bash
wkhtmltoimage --width 1200 scoreboard.html scoreboard.png
```

**Chrome headless** (if Chrome is installed):

```bash
google-chrome --headless --screenshot=scoreboard.png \
  --window-size=1200,800 scoreboard.html
```

## Skill-friendly export

For agent skills that need snapshot exports:

### Quick PNG export

```bash
# From a skill that has puppeteer or Chrome available
node scripts/snapshot-to-png.js snapshot.json /tmp/scoreboard.png
```

### Inline in skill output

Skills can:
1. Read `site/snapshot.json`
2. Render as formatted text with ASCII status indicators
3. Include PNG as attachment when visual format needed

Example skill output:

```
Pipeline Status (as of 2026-09-29 14:30 PDT)
═══════════════════════════════════════════════

Score: 2 pass · 2 wait · 1 fail

✓ PASS  CI passing on main
✓ PASS  AGENTS.md up to date
⋯ WAIT  v0.2.0 release candidate — Awaiting QA sign-off
⋯ WAIT  Integration test coverage — 3 of 5 critical paths
✗ FAIL  Performance baseline (ATL-18) — Load tests timing out

Top moves:
• QA: review v0.2.0 candidate (PR #42)
• Eng: finish integration test coverage (ATL-15)
• Eng: diagnose staging load test timeouts (ATL-18)
```

## Automation patterns

### Scheduled exports

Add to GitHub Actions or cron:

```yaml
# .github/workflows/export-scoreboard.yml
name: Export Scoreboard
on:
  schedule:
    - cron: '0 9 * * 1'  # Weekly Monday 9am
  workflow_dispatch:

jobs:
  export:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Export to PNG
        run: |
          npm install puppeteer
          node scripts/snapshot-to-png.js site/snapshot.json scoreboard.png
      - name: Upload artifact
        uses: actions/upload-artifact@v3
        with:
          name: scoreboard-snapshot
          path: scoreboard.png
```

### Email distribution

```bash
# Send weekly scoreboard PNG via email
node scripts/snapshot-to-png.js site/snapshot.json /tmp/scoreboard.png
mail -s "Weekly Pipeline Status" -a /tmp/scoreboard.png team@example.com < /dev/null
```

## Best practices

1. **Timestamp outputs** — Include date in filename: `scoreboard-2026-09-29.png`
2. **Version snapshots** — Commit snapshot.json changes to track history
3. **Automate when stable** — Once gauge definitions stabilize, schedule exports
4. **Keep it simple** — Start with HTML; add PNG only when needed
5. **Skills first** — Skills can read JSON directly; export for human distribution

## Troubleshooting

### HTML renders but PNG fails

- Ensure fonts load before screenshot (add delay or `waitForSelector`)
- Check viewport size matches content
- Verify CSS paths are correct in standalone HTML

### Styles missing in export

- Inline critical CSS rather than linking external stylesheet
- Extract only scoreboard-specific styles to keep file size reasonable

### Snapshot not found

- Verify `snapshotPath` in hub.config.js points to correct file
- Check file is committed and accessible to export scripts
- For CI/CD, ensure snapshot.json is included in checkout

## See also

- `docs/pipeline-scoreboard-schema.md` — Snapshot JSON format
- `site/snapshot.json` — Example snapshot
- `AGENTS.md` — Skill authoring guidance
