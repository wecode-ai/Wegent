#!/usr/bin/env node
/**
 * Browser Tool CLI
 *
 * Command-line interface for browser automation
 */

import { executeBrowserTool } from "./tool.js";

async function main() {
  const input = process.argv[2];

  if (!input || input === "--help" || input === "-h") {
    console.log(`Browser Tool CLI

Usage:
  browser-tool '<json>'     Execute browser action
  browser-tool --help       Show this help

Examples:
  browser-tool '{"action":"status"}'
  browser-tool '{"action":"navigate","url":"https://example.com"}'
  browser-tool '{"action":"snapshot","interactive":true}'
  browser-tool '{"action":"act","request":{"kind":"click","ref":"e1"}}'

Actions:
  status     - Check relay server and extension status
  tabs       - List attached browser tabs
  open       - Open new tab (requires url)
  close      - Close tab (requires targetId)
  focus      - Focus tab (requires targetId)
  navigate   - Navigate to URL (requires url)
  snapshot   - Get page structure with element refs
  screenshot - Capture page screenshot
  act        - Perform browser action (requires request)
  evaluate   - Execute JavaScript (requires expression)
`);
    process.exit(0);
  }

  try {
    const params = JSON.parse(input);
    const result = await executeBrowserTool(params);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, null, 2));
    process.exit(1);
  }
}

main();
