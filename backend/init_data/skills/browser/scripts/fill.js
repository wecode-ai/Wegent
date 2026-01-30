#!/usr/bin/env node
/**
 * Browser fill script using Playwright.
 *
 * This script runs in the sandbox and fills text into input fields.
 * Arguments are passed via command line as base64-encoded JSON.
 *
 * Usage: node fill.js <base64_args>
 *
 * Args (JSON):
 *   - selector: CSS selector or XPath expression for the input element
 *   - value: Text content to fill into the input
 *   - selector_type: Selector type (css, xpath)
 *   - clear_first: Clear existing content before filling
 *   - timeout_ms: Element wait timeout in milliseconds
 *   - page_url: Optional URL to navigate to first
 *
 * Output: JSON result to stdout
 */

const { chromium } = require('playwright');

async function main() {
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
    selector,
    value,
    selector_type = 'css',
    clear_first = true,
    timeout_ms = 10000,
    page_url = null,
  } = args;

  if (!selector) {
    console.log(JSON.stringify({ success: false, error: 'Selector is required' }));
    process.exit(1);
  }

  if (value === undefined || value === null) {
    console.log(JSON.stringify({ success: false, error: 'Value is required' }));
    process.exit(1);
  }

  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();

    // Navigate to page if URL provided
    if (page_url) {
      await page.goto(page_url, { waitUntil: 'networkidle', timeout: 30000 });
    }

    // Find element based on selector type
    let element;
    switch (selector_type) {
      case 'css':
        element = page.locator(selector);
        break;
      case 'xpath':
        element = page.locator(`xpath=${selector}`);
        break;
      default:
        console.log(JSON.stringify({
          success: false,
          error: `Invalid selector_type: ${selector_type}. Use 'css' or 'xpath'.`
        }));
        await browser.close();
        process.exit(1);
    }

    // Wait for element
    await element.waitFor({ timeout: timeout_ms });

    // Clear first if requested
    if (clear_first) {
      await element.clear({ timeout: timeout_ms });
    }

    // Fill the value
    await element.fill(value, { timeout: timeout_ms });

    const result = {
      success: true,
      selector: selector,
      selector_type: selector_type,
      value_length: value.length,
      clear_first: clear_first,
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
