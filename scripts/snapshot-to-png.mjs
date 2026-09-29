#!/usr/bin/env node
/**
 * Scoreboard PNG (+ optional PDF) export — generates HTML from snapshot.json
 * then screenshots it. Matches CoS LAYOUT rebuild template.
 *
 * Usage:
 *   node scripts/snapshot-to-png.mjs [snapshotPath] [--pdf]
 *   node scripts/snapshot-to-png.mjs site/snapshot.json output.png
 * 
 * Requires: npm install puppeteer-core
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse CLI args
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const snapshotPath = args[0] || 'site/snapshot.json';
const outputPath = args[1] || 'scoreboard.png';
const wantPdf = process.argv.includes('--pdf');

console.log('Pipeline Scoreboard PNG/PDF Export');
console.log('───────────────────────────────────');
console.log(`Snapshot: ${snapshotPath}`);
console.log(`Output:   ${outputPath}`);
if (wantPdf) console.log(`PDF:      ${outputPath.replace('.png', '.pdf')}`);
console.log();

// Check for puppeteer
let puppeteer;
try {
  puppeteer = await import('puppeteer-core');
} catch (err) {
  console.error('✗ Puppeteer not found. Install it first:');
  console.error('  npm install puppeteer-core\n');
  process.exit(1);
}

// Read snapshot
let snapshot;
try {
  const snapshotContent = readFileSync(resolve(snapshotPath), 'utf8');
  snapshot = JSON.parse(snapshotContent);
  console.log(`✓ Loaded snapshot: ${snapshot.gauges?.length || 0} gauges`);
} catch (err) {
  console.error(`✗ Failed to read snapshot: ${err.message}`);
  process.exit(1);
}

// Helper functions
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const shortEvidence = (evidence) => {
  if (!evidence) return "";
  if (Array.isArray(evidence)) return shortEvidence(evidence[0]);
  
  if (/^https?:\/\//.test(evidence)) {
    try {
      const url = new URL(evidence);
      const path = url.pathname;
      const prMatch = path.match(/\/pull\/(\d+)|\/issues\/(\d+)/);
      if (prMatch) return `#${prMatch[1] || prMatch[2]}`;
      const runMatch = path.match(/\/runs\/(\d+)/);
      if (runMatch) return `runs/${runMatch[1]}`;
      const segments = path.split('/').filter(Boolean);
      if (segments.length > 0) return decodeURIComponent(segments[segments.length - 1]);
      return url.host;
    } catch (e) {
      return evidence.substring(0, 32);
    }
  }
  
  if (evidence.startsWith('/')) {
    const segments = evidence.split('/').filter(Boolean);
    return segments[segments.length - 1] || evidence;
  }
  
  return evidence.length > 48 ? evidence.substring(0, 45) + "…" : evidence;
};

// Load theme if available
const themeFile = resolve(__dirname, `../site/themes/${snapshot.board}.json`);
let theme = null;
try {
  if (existsSync(themeFile)) {
    theme = JSON.parse(readFileSync(themeFile, 'utf8'));
    console.log(`✓ Loaded theme: ${theme.board}`);
  }
} catch (e) {
  console.log('  (no theme found, using defaults)');
}

const brand = theme?.brand || {};
const title = theme?.title || snapshot.title || "Pipeline Scoreboard";

// Build score HTML
const score = snapshot.score || {};
const pass = score.pass || score.PASS || 0;
const wait = score.wait || score.WAIT || 0;
const fail = score.fail || score.FAIL || 0;
const scoreHTML = [
  pass > 0 ? `<span class="pass">${pass} pass</span>` : null,
  wait > 0 ? `<span class="wait">${wait} wait</span>` : null,
  fail > 0 ? `<span class="fail">${fail} fail</span>` : null,
].filter(Boolean).join(' · ') || 'no gauges';

// Build gauges table
const gaugesHTML = (snapshot.gauges || []).map(g => {
  const status = String(g.status || '').toUpperCase();
  const rawEv = g.evidence || '';
  const shortLabel = shortEvidence(rawEv);
  let evidenceHTML = esc(shortLabel);
  if (/^https?:\/\//.test(rawEv)) {
    evidenceHTML = `<a href="${esc(rawEv)}">${esc(shortLabel)}</a>`;
  }
  
  return `<tr>
      <td>${esc(g.label || g.key || '')}</td>
      <td><span class="chip ${esc(status)}">${esc(status)}</span></td>
      <td class="ev">${evidenceHTML}</td>
    </tr>`;
}).join('\n');

// Build open work section
let openWorkHTML = '';
if (snapshot.open_work && snapshot.open_work.length > 0) {
  const rows = snapshot.open_work.map(w => {
    const id = w.id || (w.number ? `#${w.number}` : '');
    const idHTML = w.url ? `<a href="${esc(w.url)}">${esc(id)}</a>` : esc(id);
    const state = w.state || (w.isDraft ? 'draft' : 'ready');
    return `<tr><td class="ow-id">${idHTML}</td><td class="ow-title">${esc(w.title || '')}</td><td class="ow-state"><span class="chip state ${esc(state)}">${esc(state)}</span></td></tr>`;
  }).join('\n');
  
  openWorkHTML = `  <div class="card section"><h2>Open work</h2>
<table class="ow">
<thead><tr><th>ID</th><th>Title</th><th>State</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>\n`;
}

// Build drift section
let driftHTML = '';
if (snapshot.drift) {
  if (typeof snapshot.drift === 'string') {
    driftHTML = `  <div class="card section"><h2>Drift</h2><p class="drift-para">${esc(snapshot.drift)}</p></div>\n`;
  } else if (snapshot.drift.branches && Array.isArray(snapshot.drift.branches)) {
    const rows = snapshot.drift.branches.map(b => {
      const note = [
        b.ahead ? `${b.ahead} ahead` : null,
        b.behind ? `${b.behind} behind` : null,
        b.status || null,
      ].filter(Boolean).join(' · ');
      return `<tr><td class="drift-area">${esc(b.branch || '')}</td><td class="drift-note">${esc(note)}</td></tr>`;
    }).join('\n');
    driftHTML = `  <div class="card section"><h2>Drift</h2>
<table class="drift">
<thead><tr><th>Area</th><th>Note</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>\n`;
  } else if (typeof snapshot.drift === 'object') {
    const rows = Object.entries(snapshot.drift).map(([area, note]) => {
      const noteStr = typeof note === 'object' ? JSON.stringify(note) : String(note);
      return `<tr><td class="drift-area">${esc(area)}</td><td class="drift-note">${esc(noteStr)}</td></tr>`;
    }).join('\n');
    driftHTML = `  <div class="card section"><h2>Drift</h2>
<table class="drift">
<thead><tr><th>Area</th><th>Note</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>\n`;
  }
}

// Build top moves section
let movesHTML = '';
if (snapshot.top_moves && snapshot.top_moves.length > 0) {
  const items = snapshot.top_moves.map((m, i) => {
    const text = typeof m === 'object' ? (m.move || '') : String(m);
    return `<li value="${i + 1}">${esc(text)}</li>`;
  }).join('\n');
  movesHTML = `  <div class="card section"><h2>Top moves</h2><ol class="moves">${items}</ol></div>\n`;
}

// Brand row HTML
const brandRowHTML = brand.logo 
  ? `<img class="brand-mark" src="${esc(brand.logo)}" alt="" />`
  : `<div class="mark-fallback">${esc((snapshot.board || '').substring(0, 3).toUpperCase() || '?')}</div>`;

// Generate HTML
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Azeret+Mono:wght@500;600&family=DM+Sans:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700;800&family=Jost:wght@400;500;600;700;800&family=Sora:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet"/>
<style>
:root {
  --sb-bg: ${brand.bg || '#faf6f0'};
  --sb-surface: ${brand.surface || '#ffffff'};
  --sb-fg: ${brand.fg || '#2c2a25'};
  --sb-muted: ${brand.muted || '#7c756a'};
  --sb-primary: ${brand.primary || '#c2410c'};
  --sb-accent: ${brand.accent || brand.primary || '#c2410c'};
  --sb-pass: ${brand.pass || '#1a7f37'};
  --sb-wait: ${brand.wait || '#9a6700'};
  --sb-fail: ${brand.fail || '#cf222e'};
  --sb-chip-border: ${brand.chipBorder || 'rgba(60, 40, 20, 0.16)'};
  --sb-font-display: ${brand.type?.display || 'Plus Jakarta Sans'};
  --sb-font-body: ${brand.type?.body || 'Plus Jakarta Sans'};
  --sb-font-mono: ${brand.type?.mono || 'Azeret Mono'};
  --sb-rule: color-mix(in srgb, var(--sb-fg) 12%, transparent);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--sb-font-body), system-ui, sans-serif;
  background: var(--sb-bg);
  color: var(--sb-fg);
  line-height: 1.5;
  padding: 20px 16px 48px;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 920px; margin: 0 auto; }
.card {
  background: var(--sb-surface);
  border: 1px solid var(--sb-rule);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 14px;
}
.card.section { padding: 16px 20px; }
.brand-row {
  display: flex; align-items: center; gap: 12px; margin-bottom: 10px;
}
.brand-row img, .brand-mark {
  height: 40px; width: auto; display: block; border-radius: 8px; object-fit: contain;
}
.brand-row .mark-fallback {
  height: 40px; width: 40px; border-radius: 10px;
  background: var(--sb-accent); color: var(--sb-bg);
  display: grid; place-items: center;
  font-family: var(--sb-font-display), sans-serif;
  font-weight: 700; font-size: 14px; flex-shrink: 0;
}
h1 {
  font-family: var(--sb-font-display), sans-serif;
  font-size: clamp(20px, 4vw, 24px);
  font-weight: 700; letter-spacing: -0.02em;
}
h2 {
  font-family: var(--sb-font-display), sans-serif;
  font-size: 16px; font-weight: 700; margin-bottom: 10px;
}
.meta { color: var(--sb-muted); font-size: 13px; margin: 0 0 12px; }
.score {
  font-size: 17px; font-weight: 600; margin-bottom: 14px;
  font-variant-numeric: tabular-nums;
}
.score .pass { color: var(--sb-pass); }
.score .wait { color: var(--sb-wait); }
.score .fail { color: var(--sb-fail); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--sb-rule); vertical-align: top; }
th {
  color: var(--sb-muted); font-weight: 600; font-size: 12px;
  text-transform: uppercase; letter-spacing: 0.06em;
  font-family: var(--sb-font-mono), monospace;
}
.chip {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  color: #fff;
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.04em;
  border: 1px solid transparent;
  line-height: 1.3;
  white-space: nowrap;
}
.chip.PASS { background: var(--sb-pass); border-color: color-mix(in srgb, var(--sb-pass) 70%, #000); }
.chip.WAIT { background: var(--sb-wait); border-color: color-mix(in srgb, var(--sb-wait) 70%, #000); }
.chip.FAIL { background: var(--sb-fail); border-color: color-mix(in srgb, var(--sb-fail) 70%, #000); }
.chip.state {
  background: color-mix(in srgb, var(--sb-fg) 55%, transparent);
  border-color: color-mix(in srgb, var(--sb-fg) 25%, transparent);
  color: #fff;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: lowercase;
}
.chip.state.draft {
  background: color-mix(in srgb, var(--sb-muted) 85%, #000);
}
.chip.state.ready {
  background: color-mix(in srgb, var(--sb-pass) 75%, #000);
}
.ev { color: var(--sb-muted); font-size: 13px; max-width: 28ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev a { color: var(--sb-accent); text-decoration: none; }
.ev a:hover { text-decoration: underline; }
.ow-id { width: 4.5rem; white-space: nowrap; font-family: var(--sb-font-mono), monospace; font-size: 13px; }
.ow-id a { color: var(--sb-accent); text-decoration: none; font-weight: 600; }
.ow-state { width: 5.5rem; }
.drift-area { font-family: var(--sb-font-mono), monospace; font-size: 13px; white-space: nowrap; width: 42%; }
.drift-note { color: var(--sb-muted); font-size: 13px; }
.drift-para { color: var(--sb-muted); font-size: 14px; }
ol.moves {
  margin: 0; padding-left: 1.4rem;
  font-size: 14px;
}
ol.moves li { margin: 0.35rem 0; padding-left: 0.25rem; }
@media print {
  @page { size: auto; margin: 12mm; }
  body { background: var(--sb-bg) !important; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .card, .chip, .score span { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .no-print { display: none !important; }
  a { color: inherit; text-decoration: none; }
}
</style>
</head>
<body>
<div class="wrap">
  <div class="card primary">
    <div class="brand-row">${brandRowHTML}<h1>${esc(title)}</h1></div>
    <div class="meta">as of ${esc(snapshot.as_of || '')}</div>
    <div class="score">${scoreHTML}</div>
    <table class="gauges">
      <thead><tr><th>Gauge</th><th>Status</th><th>Evidence</th></tr></thead>
      <tbody>${gaugesHTML}</tbody>
    </table>
  </div>
${openWorkHTML}${driftHTML}${movesHTML}</div>
</body>
</html>`;

// Write temporary HTML file
const tempHtml = resolve(__dirname, '../scoreboard-temp.html');
writeFileSync(tempHtml, html, 'utf8');
console.log('✓ Generated HTML\n');

// Render to PNG/PDF
try {
  const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
  const browser = await puppeteer.default.launch({ 
    executablePath: chrome,
    headless: true 
  });
  const page = await browser.newPage();
  
  await page.setViewport({ 
    width: 1100, 
    height: 1600,
    deviceScaleFactor: 2
  });
  
  await page.goto(pathToFileURL(tempHtml).href, { waitUntil: 'networkidle0' });
  
  // Get actual height
  const height = await page.evaluate(
    () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
  );
  
  await page.setViewport({
    width: 1100,
    height: Math.min(height + 40, 4000),
    deviceScaleFactor: 2
  });
  
  await page.screenshot({
    path: resolve(outputPath),
    fullPage: true,
    type: 'png'
  });
  
  console.log(`✓ Exported PNG: ${outputPath}`);
  
  if (wantPdf) {
    const pdfPath = outputPath.replace('.png', '.pdf');
    await page.pdf({
      path: resolve(pdfPath),
      printBackground: true,
      preferCSSPageSize: true,
      width: '1100px',
      height: `${Math.min(height + 40, 4000)}px`
    });
    console.log(`✓ Exported PDF: ${pdfPath}`);
  }
  
  await browser.close();
  
  // Clean up temp file
  try {
    unlinkSync(tempHtml);
  } catch (e) {
    // Ignore cleanup errors
  }
  
  // Print summary
  console.log('\nSummary:');
  console.log(`  Board:  ${snapshot.board || 'N/A'}`);
  console.log(`  Title:  ${title}`);
  console.log(`  As of:  ${snapshot.as_of || 'N/A'}`);
  console.log(`  Score:  ${pass} pass · ${wait} wait · ${fail} fail`);
  
} catch (err) {
  console.error(`✗ Export failed: ${err.message}`);
  process.exit(1);
}
