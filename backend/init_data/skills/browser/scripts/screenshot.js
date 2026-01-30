#!/usr/bin/env node
/**
 * Browser screenshot script using Playwright.
 *
 * This script runs in the sandbox and captures screenshots of web pages.
 * Arguments are passed via command line as base64-encoded JSON.
 *
 * Usage: node screenshot.js <base64_args>
 *
 * Args (JSON):
 *   - file_path: Path to save the screenshot file
 *   - selector: Optional CSS selector for specific element
 *   - full_page: Capture entire scrollable page
 *   - type: Image format (png, jpeg)
 *   - quality: JPEG quality 0-100
 *   - page_url: Optional URL to navigate to first
 *
 * Output: JSON result to stdout
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

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
    file_path,
    selector = null,
    full_page = false,
    type = 'png',
    quality = null,
    page_url = null,
    timeout_ms = 30000,
  } = args;

  if (!file_path) {
    console.log(JSON.stringify({ success: false, error: 'file_path is required' }));
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
      await page.goto(page_url, { waitUntil: 'networkidle', timeout: timeout_ms });
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(file_path);
    if (parentDir) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Prepare screenshot options
    const screenshotOptions = {
      path: file_path,
      type: type,
      fullPage: full_page,
    };

    if (type === 'jpeg' && quality !== null) {
      screenshotOptions.quality = Math.max(0, Math.min(100, quality));
    }

    // Take screenshot
    if (selector) {
      const element = page.locator(selector);
      await element.waitFor({ timeout: timeout_ms });
      await element.screenshot(screenshotOptions);
    } else {
      await page.screenshot(screenshotOptions);
    }

    // Get file size
    const stats = fs.statSync(file_path);
    const fileSize = stats.size;

    const result = {
      success: true,
      file_path: file_path,
      file_size: fileSize,
      type: type,
      full_page: full_page,
    };

    if (selector) {
      result.selector = selector;
    }

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
