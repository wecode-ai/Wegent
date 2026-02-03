#!/usr/bin/env node
/**
 * Browser navigation script using Playwright.
 *
 * This script runs in the sandbox and performs browser navigation operations.
 * Arguments are passed via command line as base64-encoded JSON.
 *
 * Usage: node navigate.js <base64_args>
 *
 * Args (JSON):
 *   - url: Target URL to navigate to
 *   - action: Navigation action (goto, back, forward, reload)
 *   - wait_until: Wait condition (load, domcontentloaded, networkidle)
 *   - timeout_ms: Navigation timeout in milliseconds
 *
 * Output: JSON result to stdout
 */

const { chromium } = require('playwright');

async function main() {
  // Parse arguments from base64-encoded JSON
  const argsB64 = process.argv[2];
  if (!argsB64) {
    console.log(JSON.stringify({ success: false, error: 'No arguments provided' }));
    process.exit(1);
  }

  let args;
  try {
    const argsJson = Buffer.from(argsB64, 'base64').toString('utf-8');
    args = JSON.parse(argsJson);
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: `Failed to parse arguments: ${e.message}` }));
    process.exit(1);
  }

  const {
    url = '',
    action = 'goto',
    wait_until = 'networkidle',
    timeout_ms = 30000,
  } = args;

  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    let response = null;

    switch (action) {
      case 'goto':
        if (!url) {
          console.log(JSON.stringify({ success: false, error: "URL is required for 'goto' action" }));
          await browser.close();
          process.exit(1);
        }
        response = await page.goto(url, { waitUntil: wait_until, timeout: timeout_ms });
        break;

      case 'back':
        if (url) {
          await page.goto(url, { waitUntil: wait_until, timeout: timeout_ms });
        }
        response = await page.goBack({ waitUntil: wait_until, timeout: timeout_ms });
        break;

      case 'forward':
        if (url) {
          await page.goto(url, { waitUntil: wait_until, timeout: timeout_ms });
        }
        response = await page.goForward({ waitUntil: wait_until, timeout: timeout_ms });
        break;

      case 'reload':
        if (url) {
          await page.goto(url, { waitUntil: wait_until, timeout: timeout_ms });
        }
        response = await page.reload({ waitUntil: wait_until, timeout: timeout_ms });
        break;

      default:
        console.log(JSON.stringify({ success: false, error: `Unknown action: ${action}` }));
        await browser.close();
        process.exit(1);
    }

    const result = {
      success: true,
      url: page.url(),
      title: await page.title(),
      action: action,
      status: response ? response.status() : null,
    };

    console.log(JSON.stringify(result));
    await browser.close();
    process.exit(0);

  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
    if (browser) {
      await browser.close();
    }
    process.exit(1);
  }
}

main();
