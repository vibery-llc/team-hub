/**
 * Scoreboard PNG (+ optional PDF) export via Puppeteer/Chromium.
 *
 * Source of truth for pilots:
 *   /workspace/scoreboard-pilots/2026-09-29/render-png.mjs
 * This copy lives with the canonical schema pack so hub UI + skill export
 * share the same HTML→bytes path.
 *
 * PNG:  page.screenshot({ fullPage: true, type: 'png' })
 * PDF:  page.pdf({ printBackground: true, preferCSSPageSize: true })
 *       (pass --pdf to enable; Design should add @media print CSS first)
 *
 * Usage:
 *   node render-png.mjs [boardDir ...] [--pdf]
 *   BOARD_DIRS=/path/a,/path/b node render-png.mjs
 * Default boards: the three 2026-09-29 pilots under scoreboard-pilots.
 */
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';

const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const wantPdf = process.argv.includes('--pdf');
const args = process.argv.slice(2).filter((a) => a !== '--pdf');

const defaultBase = '/workspace/scoreboard-pilots/2026-09-29';
const defaultBoards = [
  'vibery-session-zero',
  'compass-sunday-ops',
  'cos-hanging-thread',
];

function resolveTargets() {
  if (process.env.BOARD_DIRS) {
    return process.env.BOARD_DIRS.split(',').map((d) => d.trim()).filter(Boolean);
  }
  if (args.length) {
    return args.map((a) => (path.isAbsolute(a) ? a : path.join(defaultBase, a)));
  }
  return defaultBoards.map((b) => path.join(defaultBase, b));
}

const targets = resolveTargets();

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1100,1600'],
});

for (const dir of targets) {
  const htmlPath = path.join(dir, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    console.error('skip (no index.html):', dir);
    continue;
  }
  const pngPath = path.join(dir, 'scoreboard.png');
  const pdfPath = path.join(dir, 'scoreboard.pdf');
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 1600, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
  const height = await page.evaluate(
    () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
  );
  await page.setViewport({
    width: 1100,
    height: Math.min(height + 40, 4000),
    deviceScaleFactor: 2,
  });
  await page.screenshot({ path: pngPath, fullPage: true, type: 'png' });
  console.log('wrote', pngPath, 'h=', height);
  if (wantPdf) {
    await page.pdf({
      path: pdfPath,
      printBackground: true,
      preferCSSPageSize: true,
      width: '1100px',
      height: `${Math.min(height + 40, 4000)}px`,
    });
    console.log('wrote', pdfPath);
  }
  await page.close();
}

await browser.close();
