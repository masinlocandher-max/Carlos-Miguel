const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Production-preview regression checks. Run npm run build first.
(async () => {
  const server = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      '4173',
      '--strictPort',
    ],
    { stdio: 'pipe' },
  );
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Preview did not start')), 15000);
      server.stdout.on('data', (data) => {
        if (data.toString().includes('Local:')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      server.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Preview exited: ${code}`));
      });
    });
    browser = await chromium.launch({
      executablePath: process.env.JEWEL_BROWSER_EXECUTABLE || undefined,
      args: process.env.JEWEL_BROWSER_ARGS ? JSON.parse(process.env.JEWEL_BROWSER_ARGS) : [],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const errors = [],
      requests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => requests.push(request.url()));
    const evidence = process.env.JEWEL_QA_OUTPUT;
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    async function capture(name) {
      if (evidence) await page.screenshot({ path: path.join(evidence, `${name}.png`) });
    }
    async function stackDoesNotOverlap() {
      const boxes = await page
        .locator('.core-caption, .quick-actions, .command-notice, .command-bar, .command-hint')
        .evaluateAll((elements) =>
          elements
            .filter((e) => e.checkVisibility())
            .map((e) => {
              const r = e.getBoundingClientRect();
              return {
                top: r.top,
                bottom: r.bottom,
                left: r.left,
                right: r.right,
                name: e.className,
              };
            }),
        );
      for (let i = 1; i < boxes.length; i++)
        assert(
          boxes[i].top >= boxes[i - 1].bottom - 1,
          `Command stack overlap: ${boxes[i - 1].name} / ${boxes[i].name}`,
        );
      for (const b of boxes)
        assert(
          b.left >= 0 &&
            b.right <= page.viewportSize().width &&
            b.top >= 0 &&
            b.bottom <= page.viewportSize().height,
          `Command stack clipped: ${b.name}`,
        );
    }
    for (const [width, height] of [
      [1920, 1080],
      [1440, 900],
      [1366, 768],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto('http://127.0.0.1:4173');
      await page.waitForSelector('[data-renderer="webgl"]');
      await page.evaluate(() => document.fonts.ready);
      assert.match(await page.title(), /Jewel OS/);
      assert.equal(await page.locator('dialog').isVisible(), false);
      assert.equal(await page.locator('img,video').count(), 0);
      await stackDoesNotOverlap();
      await capture(`home-${width}`);
      const bounds = await page.locator('.jewel-stage').boundingBox();
      await page.getByRole('button', { name: 'Focus Mode', exact: true }).click();
      assert.deepEqual(await page.locator('.jewel-stage').boundingBox(), bounds);
      for (const selector of ['.brand-group', '.statusbar', '.preview-badge', '.quick-actions'])
        assert.equal(
          await page.locator(selector).isVisible(),
          false,
          `Focus chrome visible: ${selector}`,
        );
      assert(await page.getByRole('textbox', { name: 'Command Jewel' }).isVisible());
      await stackDoesNotOverlap();
      await capture(`focus-${width}`);
      await page.getByRole('button', { name: 'Exit Focus', exact: true }).click();
      assert.deepEqual(await page.locator('.jewel-stage').boundingBox(), bounds);
      await page.getByRole('button', { name: 'Brief me', exact: true }).click();
      await stackDoesNotOverlap();
      if (width <= 900) {
        await page.waitForFunction(() => {
          const panel = document.querySelector('.context-panel').getBoundingClientRect();
          const notice = document.querySelector('.command-notice').getBoundingClientRect();
          return panel.bottom + 11 <= notice.top;
        });
        const dismiss = await page.getByRole('button', { name: 'Dismiss message' }).boundingBox();
        assert(dismiss.width >= 44 && dismiss.height >= 44);
        assert(await page.getByRole('textbox', { name: 'Command Jewel' }).isVisible());
        assert(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              document.documentElement.scrollHeight <= innerHeight,
          ),
        );
      }
      await capture(`notice-${width}`);
      await page.getByRole('button', { name: 'Dismiss message' }).click();
      if (width <= 900)
        assert.equal(
          await page.locator('.context-panel').evaluate((e) => getComputedStyle(e).bottom),
          '177px',
        );
      console.log(`PASS layout, notice and Focus bounds: ${width}x${height}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
    await menu.focus();
    await page.keyboard.press('Enter');
    assert(await page.locator('dialog').isVisible());
    assert.equal(await page.locator('nav[aria-label="Primary navigation"] button').count(), 8);
    await page.keyboard.press('Tab');
    assert.equal(
      await page.evaluate(() => document.activeElement.textContent),
      'Home / Command Center',
    );
    await page.keyboard.press('Escape');
    assert(await menu.evaluate((e) => e === document.activeElement));
    await menu.press('Enter');
    await page.getByRole('button', { name: 'Projects', exact: true }).press('Enter');
    assert(await menu.evaluate((e) => e === document.activeElement));
    assert.equal(await page.locator('dialog').isVisible(), false);
    assert.match(await page.title(), /Projects/);
    console.log('PASS navigation keyboard selection, Escape and focus restoration');
    for (const command of ['open projects', 'open files', 'focus mode']) {
      await page.evaluate(() => {
        window.qaStates = [];
        window.qaObserver?.disconnect();
        window.qaObserver = new MutationObserver(() =>
          window.qaStates.push(document.querySelector('.app').dataset.state),
        );
        window.qaObserver.observe(document.querySelector('.app'), {
          attributes: true,
          attributeFilter: ['data-state'],
        });
      });
      const input = page.getByRole('textbox', { name: 'Command Jewel' });
      await input.fill(command);
      await input.press('Enter');
      await page.waitForFunction(
        () =>
          window.qaStates.includes('complete') &&
          document.querySelector('.app').dataset.state === 'idle',
      );
      assert.deepEqual(await page.evaluate(() => window.qaStates), [
        'listening',
        'thinking',
        'executing',
        'complete',
        'idle',
      ]);
      if (command === 'open files') assert.match(await page.title(), /Files & Assets/);
      if (command === 'focus mode')
        assert(await page.getByRole('button', { name: 'Exit Focus' }).isVisible());
      await page.keyboard.press('Escape');
      console.log(`PASS five-state sequence: ${command}`);
    }
    assert.deepEqual(errors, []);
    assert(
      !requests.some(
        (url) =>
          !url.startsWith('http://127.0.0.1:4173/') ||
          /identity|filaments\.bin|references\/|likeness/i.test(url),
      ),
      'Unexpected external/private visual request',
    );
    console.log('PASS no runtime errors or private/external requests');
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
