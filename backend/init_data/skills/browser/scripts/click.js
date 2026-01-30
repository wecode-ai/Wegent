#!/usr/bin/env node
/**
 * Browser click script using Playwright.
 *
 * This script runs in the sandbox and performs element click operations.
 * Arguments are passed via command line as base64-encoded JSON.
 *
 * Usage: node click.js <base64_args>
 *
 * Args (JSON):
 *   - selector: CSS selector, XPath expression, or text content
 *   - selector_type: Selector type (css, xpath, text)
 *   - timeout_ms: Element wait timeout in milliseconds
 *   - force: Force click even if element is not visible
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
    selector_type = 'css',
    timeout_ms = 10000,
    force = false,
    page_url = null,
  } = args;

  if (!selector) {
    console.log(JSON.stringify({ success: false, error: 'Selector is required' }));
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
      case 'text':
        element = page.getByText(selector);
        break;
      default:
        console.log(JSON.stringify({
          success: false,
          error: `Invalid selector_type: ${selector_type}. Use 'css', 'xpath', or 'text'.`
        }));
        await browser.close();
        process.exit(1);
    }

    // Wait for element and click
    await element.waitFor({ timeout: timeout_ms });
    await element.click({ force: force, timeout: timeout_ms });

    // Get element info
    let elementInfo = {};
    try {
      elementInfo = {
        tag_name: await element.evaluate(el => el.tagName.toLowerCase()),
        text_content: (await element.textContent() || '').substring(0, 100),
        class: await element.getAttribute('class') || '',
        id: await element.getAttribute('id') || '',
      };
    } catch (e) {
      // Ignore errors getting element info
    }

    const result = {
      success: true,
      selector: selector,
      selector_type: selector_type,
      element_info: elementInfo,
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
