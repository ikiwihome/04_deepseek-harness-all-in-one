import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/opt/dsh-tools/package.json');
const { chromium } = require('playwright');
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 60_000 }).trim();
const directory = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-tools-'));
try {
  console.log(run('python', ['--version']));
  console.log(run('ffmpeg', ['-version']).split('\n')[0]);
  console.log(run('chromium', ['--version']));
  console.log(run('playwright', ['--version']));
  const video = path.join(directory, 'check.mp4');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=5', '-t', '0.2', '-y', video]);
  const info = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', video]));
  assert.equal(info.streams[0].width, 32);
  assert.equal(info.streams[0].codec_type, 'video');

  for (const channel of [undefined, 'chromium']) {
    const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    try {
      const page = await browser.newPage();
      await page.setContent('<html><title>runtime check</title><body>中文 Chromium ✓</body></html>');
      assert.equal(await page.title(), 'runtime check');
      const png = await page.screenshot();
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
    } finally { await browser.close(); }
  }
  const pythonVersion = run('python', ['-c', 'from importlib.metadata import version; print(version("playwright"))']);
  assert.equal(pythonVersion, require('playwright/package.json').version);
  run('python', ['-c', `from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        page.set_content('<html><title>Python browser check</title></html>')
        assert page.title() == 'Python browser check'
        assert page.screenshot()[1:4] == b'PNG'
    finally:
        browser.close()
`]);
  assert.ok(readFileSync(video).length > 0);
  console.log('runtime tools OK: video encoding, Node/Python Playwright, Chromium and screenshots');
} finally { rmSync(directory, { recursive: true, force: true }); }
