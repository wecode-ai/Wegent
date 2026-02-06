#!/usr/bin/env node
import { ensureRelayServer } from "./relay-server.js";
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, openSync, lstatSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 9224;
const DEFAULT_BROWSER_PREFIX = join(homedir(), ".wegent-executor", "browser");

function getBrowserPrefix(): string {
  return process.env.BROWSER_PREFIX || DEFAULT_BROWSER_PREFIX;
}

function getTokenFilePath(): string {
  return join(getBrowserPrefix(), ".token");
}

function getPidFilePath(): string {
  return join(getBrowserPrefix(), "relay.pid");
}

function getLogFilePath(): string {
  return join(getBrowserPrefix(), "relay.log");
}

function readPid(): number | null {
  const pidFile = getPidFilePath();
  if (!existsSync(pidFile)) {
    return null;
  }
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopDaemon(): boolean {
  const pid = readPid();
  if (!pid) {
    console.log("No PID file found. Server may not be running.");
    return false;
  }
  if (!isProcessRunning(pid)) {
    console.log(`Process ${pid} not running. Cleaning up PID file.`);
    try { unlinkSync(getPidFilePath()); } catch {}
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped relay server (PID: ${pid})`);
    // Wait a moment then clean up
    setTimeout(() => {
      try { unlinkSync(getPidFilePath()); } catch {}
    }, 500);
    return true;
  } catch (err) {
    console.error(`Failed to stop process ${pid}:`, err);
    return false;
  }
}

function startDaemon(): void {
  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    console.log(`Relay server already running (PID: ${pid})`);
    process.exit(0);
  }

  const browserPrefix = getBrowserPrefix();
  mkdirSync(browserPrefix, { recursive: true });

  const logFile = getLogFilePath();
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");

  const args = process.argv.slice(2).filter(arg => !["--daemon", "--restart", "--stop"].includes(arg));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, __DAEMON_CHILD__: "1" },
  });

  writeFileSync(getPidFilePath(), String(child.pid));
  console.log(`Relay server started in background (PID: ${child.pid})`);
  console.log(`  Log file: ${logFile}`);
  console.log(`  PID file: ${getPidFilePath()}`);

  child.unref();
  process.exit(0);
}

function getExtensionPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // In dist/, go up one level to find chrome-extension/
  const extPath = resolve(__dirname, "..", "chrome-extension");
  if (existsSync(extPath)) {
    return extPath;
  }
  // Fallback for running from src/
  return resolve(__dirname, "..", "..", "chrome-extension");
}

function getChromePath(): string | null {
  const paths: string[] = [];

  if (platform() === "darwin") {
    paths.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else if (platform() === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    paths.push(
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
    );
  } else {
    // Linux
    paths.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser"
    );
  }

  for (const p of paths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

function isExtensionInstalled(userDataDir: string): boolean {
  // Check if extension was previously installed by looking for our marker file
  const markerFile = join(userDataDir, ".extension-installed");
  return existsSync(markerFile);
}

function markExtensionInstalled(userDataDir: string): void {
  const markerFile = join(userDataDir, ".extension-installed");
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(markerFile, new Date().toISOString());
}

function isChromeRunningWithProfile(): boolean {
  const userDataDir = join(getBrowserPrefix(), "chrome-profile");
  const lockFile = join(userDataDir, "SingletonLock");
  try {
    const stats = lstatSync(lockFile);
    return stats.isSymbolicLink() || stats.isFile();
  } catch {
    return false;
  }
}

function launchChrome(extensionPath: string): ChildProcess | null {
  // Don't launch if Chrome is already running with our profile
  if (isChromeRunningWithProfile()) {
    console.log("Chrome is already running with this profile.");
    return null;
  }

  const chromePath = process.env.CHROME_PATH || getChromePath();
  if (!chromePath) {
    console.warn("Chrome not found. Please set CHROME_PATH environment variable.");
    return null;
  }

  const userDataDir = join(getBrowserPrefix(), "chrome-profile");
  const firstRun = !isExtensionInstalled(userDataDir);

  const args = [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://weibo.com",  // Open a page for attach
  ];

  console.log(`Launching Chrome...`);
  console.log(`  Chrome: ${chromePath}`);
  console.log(`  Profile: ${userDataDir}`);

  if (firstRun) {
    console.log(`\n*** FIRST RUN: Please install the extension manually ***`);
    console.log(`  1. Enable "Developer mode" (top right)`);
    console.log(`  2. Click "Load unpacked"`);
    console.log(`  3. Select: ${extensionPath}`);
    console.log(`  4. Extension will auto-attach after install\n`);
    markExtensionInstalled(userDataDir);
  }

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
  });

  child.unref();

  // On macOS, use osascript to open chrome://extensions after Chrome starts
  if (firstRun && platform() === "darwin") {
    spawn("osascript", ["-e", `
      delay 2
      tell application "Google Chrome"
        activate
        open location "chrome://extensions/"
        delay 0.5
        set active tab index of front window to (count of tabs of front window)
      end tell
    `], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }

  return child;
}

async function main() {
  // Handle daemon commands
  const args = process.argv.slice(2);

  if (args.includes("--stop")) {
    stopDaemon();
    process.exit(0);
  }

  if (args.includes("--restart")) {
    stopDaemon();
    // Wait for process to stop
    await new Promise(r => setTimeout(r, 1000));
    startDaemon();
    return;
  }

  if (args.includes("--daemon") && !process.env.__DAEMON_CHILD__) {
    startDaemon();
    return;
  }

  const port = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
  const host = process.env.HOST || "127.0.0.1";
  const cdpUrl = `http://${host}:${port}`;
  const launchBrowser = args.includes("--launch") || process.env.LAUNCH_BROWSER === "1";

  console.log(`Starting CDP relay server...`);

  const relay = await ensureRelayServer({ cdpUrl });

  // Write auth token for skill to use
  const tokenFile = getTokenFilePath();
  try {
    mkdirSync(dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, relay.authToken, "utf-8");
    console.log(`Auth token written to: ${tokenFile}`);
  } catch (err) {
    console.warn(`Warning: Could not write token file: ${err}`);
  }

  console.log(`\nCDP Relay Server running:`);
  console.log(`  Base URL:    ${relay.baseUrl}`);
  console.log(`  CDP WS URL:  ${relay.cdpWsUrl}`);
  console.log(`  Extension:   ws://${host}:${port}/extension`);

  if (launchBrowser) {
    const extensionPath = getExtensionPath();
    if (existsSync(extensionPath)) {
      launchChrome(extensionPath);
    } else {
      console.warn(`Extension not found at: ${extensionPath}`);
    }
  }

  console.log(`\nWaiting for Chrome extension to connect...`);

  // Keep process alive
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await relay.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await relay.stop();
    process.exit(0);
  });

  // Status check interval
  setInterval(() => {
    const connected = relay.extensionConnected();
    if (connected) {
      console.log(`[${new Date().toISOString()}] Extension: connected`);
    }
  }, 30000);
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
