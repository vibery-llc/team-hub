# Exporting Pipeline Scoreboard Snapshots

The pipeline scoreboard snapshot can be exported to standalone HTML and PNG formats for sharing, archiving, or use in skills and automation.

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

## Export to PNG

PNG export requires rendering the HTML to an image. Two common approaches:

### Using Puppeteer (Node.js)

```javascript
// scripts/snapshot-to-png.js
const puppeteer = require('puppeteer');
const fs = require('fs');

async function exportSnapshotToPNG(snapshotPath, outputPath) {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  // Set viewport for consistent sizing
  await page.setViewport({ width: 1200, height: 800 });
  
  // Load the HTML (either live URL or generated file)
  await page.goto('file://' + process.cwd() + '/scoreboard.html', {
    waitUntil: 'networkidle0'
  });
  
  // Wait for scoreboard to render
  await page.waitForSelector('#pipeline-scoreboard');
  
  // Take screenshot of just the scoreboard section
  const element = await page.$('#pipeline-scoreboard');
  await element.screenshot({
    path: outputPath,
    omitBackground: false
  });
  
  await browser.close();
  console.log(`Exported to ${outputPath}`);
}

// Usage
const [snapshotPath, outputPath] = process.argv.slice(2);
exportSnapshotToPNG(
  snapshotPath || 'site/snapshot.json',
  outputPath || 'scoreboard.png'
);
```

Install and run:

```bash
npm install puppeteer
node scripts/snapshot-to-png.js site/snapshot.json output.png
```

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
