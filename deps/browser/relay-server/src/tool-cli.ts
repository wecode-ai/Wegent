#!/usr/bin/env node
/**
 * Browser Tool CLI
 *
 * Command-line interface for browser automation
 */

import * as fs from "node:fs";
import { executeBrowserTool } from "./tool.js";

const LINUX_GUI_ENV_DEFAULTS = {
  DISPLAY: ":0",
  WAYLAND_DISPLAY: "wayland-0",
} as const;

function getLinuxRuntimeDir(): string {
  if (process.env.XDG_RUNTIME_DIR) {
    return process.env.XDG_RUNTIME_DIR;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return `/run/user/${uid}`;
}

function getLinuxDbusSessionBusAddress(): string {
  if (process.env.DBUS_SESSION_BUS_ADDRESS) {
    return process.env.DBUS_SESSION_BUS_ADDRESS;
  }

  return `unix:path=${getLinuxRuntimeDir()}/bus`;
}

function resolveLinuxXauthority(): string | null {
  const runtimeDir = getLinuxRuntimeDir();

  try {
    const candidates = fs
      .readdirSync(runtimeDir)
      .filter((name) => name.startsWith(".mutter-Xwaylandauth."));

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort();
    return `${runtimeDir}/${candidates[candidates.length - 1]}`;
  } catch {
    return null;
  }
}

function applyLinuxGuiEnvDefaults(): void {
  if (process.platform !== "linux") {
    return;
  }

  if (!process.env.DISPLAY) {
    process.env.DISPLAY = LINUX_GUI_ENV_DEFAULTS.DISPLAY;
  }

  if (!process.env.WAYLAND_DISPLAY) {
    process.env.WAYLAND_DISPLAY = LINUX_GUI_ENV_DEFAULTS.WAYLAND_DISPLAY;
  }

  if (!process.env.XDG_RUNTIME_DIR) {
    process.env.XDG_RUNTIME_DIR = getLinuxRuntimeDir();
  }

  if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
    process.env.DBUS_SESSION_BUS_ADDRESS = getLinuxDbusSessionBusAddress();
  }

  if (!process.env.XAUTHORITY) {
    const xauthority = resolveLinuxXauthority();
    if (xauthority) {
      process.env.XAUTHORITY = xauthority;
    }
  }
}

async function main() {
  applyLinuxGuiEnvDefaults();

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
