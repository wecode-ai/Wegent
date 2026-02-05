/**
 * Browser Tool
 *
 * LLM tool interface for browser control
 */

import {
  createBrowserClient,
  type BrowserClient,
  getStatus,
  listTabs,
  openTab,
  closeTab,
  focusTab,
  navigate,
  screenshot,
  evaluate,
} from "./browser-client.js";
import { getSnapshot, storeRefs } from "./snapshot.js";
import { executeAction, type ActRequest } from "./actions.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_BROWSER_PREFIX = path.join(os.homedir(), ".wegent-executor", "browser");

function getBrowserPrefix(): string {
  return process.env.BROWSER_PREFIX || DEFAULT_BROWSER_PREFIX;
}

function getExtensionPath(): string {
  // Check multiple possible locations
  const possiblePaths = [
    // Installed via npm
    path.resolve(__dirname, "..", "chrome-extension"),
    // Development
    path.resolve(__dirname, "..", "..", "chrome-extension"),
    // Global install
    path.join(os.homedir(), ".wegent-executor", "lib", "node_modules", "cdp-relay-server", "chrome-extension"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return possiblePaths[0]; // Default to first option
}

function getChromePath(): string | null {
  const platform = os.platform();
  const paths: string[] = [];

  if (platform === "darwin") {
    paths.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else if (platform === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    paths.push(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
    );
  } else {
    paths.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser"
    );
  }

  for (const p of paths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function isChromeRunningWithProfile(): boolean {
  const userDataDir = path.join(getBrowserPrefix(), "chrome-profile");
  const lockFile = path.join(userDataDir, "SingletonLock");
  // On macOS/Linux, SingletonLock is a symlink when Chrome is running
  // On Windows, it's a file
  try {
    const stats = fs.lstatSync(lockFile);
    return stats.isSymbolicLink() || stats.isFile();
  } catch {
    return false;
  }
}

function launchBrowserWithInstructions(url?: string): { launched: boolean; message: string } {
  // Don't launch if Chrome is already running with our profile
  if (isChromeRunningWithProfile()) {
    return {
      launched: false,
      message: "Chrome is already running. Please click the extension icon on a tab to attach.",
    };
  }

  const chromePath = process.env.CHROME_PATH || getChromePath();
  if (!chromePath) {
    return {
      launched: false,
      message: "Chrome not found. Please install Chrome or set CHROME_PATH environment variable.",
    };
  }

  const userDataDir = path.join(getBrowserPrefix(), "chrome-profile");
  // Use provided URL, or open a blank page if none provided
  const targetUrl = url || "about:blank";

  const args = [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    targetUrl,
  ];

  try {
    const child = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    return {
      launched: true,
      message: "Browser launched",
    };
  } catch (err) {
    return {
      launched: false,
      message: `Failed to launch browser: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function openExtensionsPage(): { opened: boolean; message: string } {
  const extensionPath = getExtensionPath();

  // On macOS, use osascript to open chrome://extensions
  if (os.platform() === "darwin") {
    try {
      spawn("osascript", ["-e", `
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

      return {
        opened: true,
        message: `Opening chrome://extensions. Please install the extension:
1. Enable "Developer mode" (top right toggle)
2. Click "Load unpacked"
3. Select folder: ${extensionPath}
4. Click extension icon on a tab to attach`,
      };
    } catch (err) {
      return {
        opened: false,
        message: `Failed to open extensions page: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // For other platforms, return instructions
  return {
    opened: false,
    message: `Please install the extension manually:
1. Go to chrome://extensions
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select folder: ${extensionPath}
5. Click extension icon on a tab to attach`,
  };
}

function openUrlInChrome(url: string): void {
  // On macOS, use osascript to open URL in Chrome
  if (os.platform() === "darwin") {
    try {
      spawn("osascript", ["-e", `
        tell application "Google Chrome"
          activate
          open location "${url}"
        end tell
      `], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } catch {
      // Ignore errors
    }
  }
}

async function waitForConnection(maxWaitMs: number = 5000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const status = await getStatus();
    if (status.extensionConnected) {
      return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Tool Schema for LLM
export const browserToolSchema = {
  name: "browser",
  description: `Control browser to interact with web pages. Requires relay server running and Chrome extension attached to a tab.

Actions:
- status: Check if browser relay is running and extension is connected
- tabs: List attached browser tabs
- open: Open a new tab with URL
- close: Close a tab
- focus: Focus/activate a tab
- navigate: Navigate current tab to URL
- snapshot: Get page structure with element refs for interaction
- screenshot: Capture page screenshot
- act: Perform browser action (click, type, hover, etc.)
- evaluate: Execute JavaScript (use with caution)

Workflow:
1. Check status to ensure extension is connected
2. Use snapshot to see page structure and get element refs
3. Use act with refs to interact (click, type, etc.)
4. Use snapshot again to see results`,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "status",
          "tabs",
          "open",
          "close",
          "focus",
          "navigate",
          "snapshot",
          "screenshot",
          "act",
          "evaluate",
        ],
        description: "Action to perform",
      },
      url: {
        type: "string",
        description: "URL for open/navigate actions",
      },
      targetId: {
        type: "string",
        description: "Tab targetId for close/focus actions",
      },
      interactive: {
        type: "boolean",
        description: "For snapshot: only show interactive elements",
      },
      compact: {
        type: "boolean",
        description: "For snapshot: compact output",
      },
      fullPage: {
        type: "boolean",
        description: "For screenshot: capture full page",
      },
      ensure: {
        type: "boolean",
        description: "For status: ensure browser profile is launched and try to attach extension",
      },
      request: {
        type: "object",
        description: "For act: action request object",
        properties: {
          kind: {
            type: "string",
            enum: ["click", "type", "press", "hover", "drag", "select", "fill", "scroll", "wait", "resize"],
          },
          ref: { type: "string", description: "Element ref from snapshot (e.g., e1, e2)" },
          text: { type: "string", description: "Text for type action" },
          key: { type: "string", description: "Key for press action" },
          submit: { type: "boolean", description: "Press Enter after typing" },
          doubleClick: { type: "boolean", description: "Double click" },
          startRef: { type: "string", description: "Start ref for drag" },
          endRef: { type: "string", description: "End ref for drag" },
          values: { type: "array", items: { type: "string" }, description: "Values for select" },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ref: { type: "string" },
                value: { type: "string" },
              },
            },
            description: "Fields for fill",
          },
          direction: { type: "string", enum: ["up", "down", "left", "right"] },
          amount: { type: "number" },
          timeMs: { type: "number" },
          selector: { type: "string" },
          width: { type: "number" },
          height: { type: "number" },
        },
      },
      expression: {
        type: "string",
        description: "JavaScript expression for evaluate action",
      },
    },
    required: ["action"],
  },
};

export type BrowserToolParams = {
  action: string;
  url?: string;
  targetId?: string;
  interactive?: boolean;
  compact?: boolean;
  fullPage?: boolean;
  ensure?: boolean;
  request?: ActRequest;
  expression?: string;
};

export type BrowserToolResult = {
  ok: boolean;
  error?: string;
  data?: unknown;
};

function isConnectionErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("no auth token found") ||
    lower.includes("relay server not running") ||
    lower.includes("browser extension not connected") ||
    lower.includes("connection not open") ||
    lower.includes("econnrefused") ||
    lower.includes("fetch failed") ||
    lower.includes("socket hang up") ||
    lower.includes("websocket") ||
    lower.includes("unexpected server response: 503") ||
    lower.includes("unexpected server response: 409")
  );
}

async function tryEnsureConnected(params: BrowserToolParams): Promise<{
  connected: boolean;
  error?: string;
}> {
  const status = await getStatus();

  if (!status.relayRunning) {
    return {
      connected: false,
      error: "Relay server not running. Start it with: cdp-relay-server",
    };
  }

  if (status.extensionConnected) {
    return { connected: true };
  }

  const chromeRunning = isChromeRunningWithProfile();
  const targetUrl = (params.action === "open" || params.action === "navigate") ? params.url : undefined;

  if (!chromeRunning) {
    // Chrome not running - launch with user's URL first
    const launchResult = launchBrowserWithInstructions(targetUrl);
    if (!launchResult.launched) {
      return { connected: false, error: launchResult.message };
    }
  } else if (targetUrl) {
    // Chrome is running but extension not connected - open the target page first
    // Extension may auto-attach to the new tab
    openUrlInChrome(targetUrl);
  }

  // Wait for extension to attach
  const connected = await waitForConnection(3000);

  if (connected) {
    return { connected: true };
  }

  // Attach failed - extension probably not installed, now open extensions page
  const extResult = openExtensionsPage();
  return {
    connected: false,
    error: `Extension not connected. ${extResult.message}`,
  };
}

/**
 * Execute browser tool
 */
export async function executeBrowserTool(params: BrowserToolParams): Promise<BrowserToolResult> {
  const runAction = async (): Promise<BrowserToolResult> => {
    const runWithClient = async <T>(fn: (client: BrowserClient) => Promise<T>): Promise<T> => {
      const client = await createBrowserClient({ skipStatusCheck: true });
      try {
        return await fn(client);
      } finally {
        client.close();
      }
    };

    switch (params.action) {

      case "tabs": {
        const tabs = await listTabs();
        return { ok: true, data: { tabs } };
      }

      case "open": {
        if (!params.url) {
          return { ok: false, error: "url is required for open action" };
        }
        // Check if there's a temporary tab (weibo.com or chrome://extensions) to reuse
        const tabs = await listTabs();
        const tempTab = tabs.find(t =>
          t.url.includes("weibo.com") ||
          t.url.startsWith("chrome://extensions") ||
          t.url === "chrome://newtab/" ||
          t.url === "about:blank"
        );
        if (tempTab) {
          // Reuse temp tab by navigating instead of opening new tab
          await runWithClient(async (client) => {
            await navigate(params.url!, tempTab.targetId, { client });
          });
          return { ok: true, data: { targetId: tempTab.targetId, reused: true } };
        }
        const result = await runWithClient(async (client) => {
          return await openTab(params.url!, { client });
        });
        return { ok: true, data: result };
      }

      case "close": {
        if (!params.targetId) {
          return { ok: false, error: "targetId is required for close action" };
        }
        const result = await runWithClient(async (client) => {
          return await closeTab(params.targetId!, { client });
        });
        return { ok: true, data: result };
      }

      case "focus": {
        if (!params.targetId) {
          return { ok: false, error: "targetId is required for focus action" };
        }
        await runWithClient(async (client) => {
          await focusTab(params.targetId!, { client });
        });
        return { ok: true, data: { focused: params.targetId } };
      }

      case "navigate": {
        if (!params.url) {
          return { ok: false, error: "url is required for navigate action" };
        }
        const result = await runWithClient(async (client) => {
          return await navigate(params.url!, undefined, { client });
        });
        return { ok: true, data: result };
      }

      case "snapshot": {
        const result = await runWithClient(async (client) => {
          return await getSnapshot({
            interactive: params.interactive,
            compact: params.compact,
            client,
          });
        });
        // Store refs for subsequent actions
        storeRefs(result.refs);
        return {
          ok: true,
          data: {
            snapshot: result.snapshot,
            stats: result.stats,
          },
        };
      }

      case "screenshot": {
        const buffer = await runWithClient(async (client) => {
          return await screenshot({ fullPage: params.fullPage, client });
        });
        // Save to temp file
        const tmpDir = path.join(os.tmpdir(), "browser-skill");
        if (!fs.existsSync(tmpDir)) {
          fs.mkdirSync(tmpDir, { recursive: true });
        }
        const filePath = path.join(tmpDir, `screenshot-${Date.now()}.png`);
        fs.writeFileSync(filePath, buffer);
        return {
          ok: true,
          data: {
            path: filePath,
            size: buffer.length,
          },
        };
      }

      case "act": {
        if (!params.request) {
          return { ok: false, error: "request is required for act action" };
        }
        const result = await runWithClient(async (client) => {
          return await executeAction(params.request!, { client });
        });
        return { ok: result.ok, error: result.error, data: result.ok ? { acted: params.request.kind } : undefined };
      }

      case "evaluate": {
        if (!params.expression) {
          return { ok: false, error: "expression is required for evaluate action" };
        }
        const result = await runWithClient(async (client) => {
          return await evaluate(params.expression!, { client });
        });
        return {
          ok: !result.error,
          error: result.error,
          data: result.result,
        };
      }

      default:
        return { ok: false, error: `Unknown action: ${params.action}` };
    }
  };

  // For status action, just return status without auto-launching
  if (params.action === "status") {
    try {
      let launched = false;
      let launchMessage: string | undefined;
      let waitedForAttach = false;

      if (params.ensure) {
        const ensureUrl = typeof params.url === "string" ? params.url : undefined;
        const running = isChromeRunningWithProfile();
        if (!running) {
          const launchResult = launchBrowserWithInstructions(ensureUrl);
          launched = launchResult.launched;
          launchMessage = launchResult.message;
        } else if (ensureUrl) {
          openUrlInChrome(ensureUrl);
        }
        waitedForAttach = true;
        await waitForConnection(5000);
      }

      const status = await getStatus();
      return {
        ok: true,
        data: {
          relayRunning: status.relayRunning,
          extensionConnected: status.extensionConnected,
          attachedTabs: status.targets.length,
          targets: status.targets,
          ...(params.ensure
            ? {
                ensure: {
                  requested: true,
                  launched,
                  launchMessage,
                  waitedForAttach,
                },
              }
            : {}),
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  try {
    return await runAction();
  } catch (err) {
    const firstError = err instanceof Error ? err.message : String(err);
    if (!isConnectionErrorMessage(firstError)) {
      return {
        ok: false,
        error: firstError,
      };
    }

    const ensure = await tryEnsureConnected(params);
    if (!ensure.connected) {
      return {
        ok: false,
        error: ensure.error ?? firstError,
      };
    }

    try {
      return await runAction();
    } catch (retryErr) {
      return {
        ok: false,
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      };
    }
  }
}
