/**
 * Browser Client
 *
 * Connects to externally running CDP relay server
 */

import WebSocket, { type RawData } from "ws";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_RELAY_PORT = 9224;
const DEFAULT_BROWSER_PREFIX = path.join(os.homedir(), ".wegent-executor", "browser");

function getBrowserPrefix(): string {
  return process.env.BROWSER_PREFIX || DEFAULT_BROWSER_PREFIX;
}

function getTokenFilePath(): string {
  return path.join(getBrowserPrefix(), ".token");
}

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message?: string };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

type TargetInfo = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  return String(data);
}

function getRelayPort(): number {
  const envPort = process.env.BROWSER_RELAY_PORT;
  if (envPort) {
    const port = parseInt(envPort, 10);
    if (!isNaN(port) && port > 0 && port < 65536) return port;
  }
  return DEFAULT_RELAY_PORT;
}

function getAuthToken(): string | null {
  const tokenFile = getTokenFilePath();
  try {
    if (fs.existsSync(tokenFile)) {
      return fs.readFileSync(tokenFile, "utf-8").trim();
    }
  } catch {}
  return null;
}

export type RelayStatus = {
  relayRunning: boolean;
  extensionConnected: boolean;
  targets: Array<{ targetId: string; title: string; url: string }>;
};

/**
 * Check relay server status via HTTP
 */
export async function getStatus(): Promise<RelayStatus> {
  const port = getRelayPort();
  const token = getAuthToken();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Check if server is running
    const rootRes = await fetch(baseUrl, { method: "HEAD" });
    if (!rootRes.ok) {
      return { relayRunning: false, extensionConnected: false, targets: [] };
    }

    // Check extension status
    const statusRes = await fetch(`${baseUrl}/extension/status`);
    const statusData = (await statusRes.json()) as { connected?: boolean };
    const extensionConnected = statusData?.connected ?? false;

    // Get targets list
    let targets: Array<{ targetId: string; title: string; url: string }> = [];
    if (extensionConnected && token) {
      const listRes = await fetch(`${baseUrl}/json/list`, {
        headers: { "x-cdp-relay-token": token },
      });
      if (listRes.ok) {
        const list = (await listRes.json()) as TargetInfo[];
        targets = list.map((t) => ({
          targetId: t.id,
          title: t.title,
          url: t.url,
        }));
      }
    }

    return { relayRunning: true, extensionConnected, targets };
  } catch {
    return { relayRunning: false, extensionConnected: false, targets: [] };
  }
}

export type BrowserClient = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
};

export async function createBrowserClient(): Promise<BrowserClient> {
  const port = getRelayPort();
  const token = getAuthToken();

  if (!token) {
    throw new Error("No auth token found. Is relay server running?");
  }

  // Check status first
  const status = await getStatus();
  if (!status.relayRunning) {
    throw new Error("Relay server not running. Start it with: cd ~/dev/git/browser/relay-server && npm start");
  }
  if (!status.extensionConnected) {
    throw new Error("Browser extension not connected. Click extension icon on a tab to attach.");
  }

  const wsUrl = `ws://127.0.0.1:${port}/cdp`;
  const ws = new WebSocket(wsUrl, {
    headers: { "x-cdp-relay-token": token },
    handshakeTimeout: 5000,
  });

  let nextId = 1;
  const pending = new Map<number, Pending>();

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });

  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(rawDataToString(data)) as CdpResponse;
      if (typeof parsed.id !== "number") return;
      const p = pending.get(parsed.id);
      if (!p) return;
      pending.delete(parsed.id);
      if (parsed.error?.message) {
        p.reject(new Error(parsed.error.message));
      } else {
        p.resolve(parsed.result);
      }
    } catch {}
  });

  ws.on("close", () => {
    for (const [, p] of pending) {
      p.reject(new Error("Connection closed"));
    }
    pending.clear();
  });

  const send = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Connection not open"));
    }
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  return {
    send,
    close: () => ws.close(),
  };
}

// High-level browser operations

export async function listTabs(): Promise<
  Array<{ targetId: string; title: string; url: string }>
> {
  const status = await getStatus();
  return status.targets;
}

export async function openTab(url: string): Promise<{ targetId: string }> {
  const client = await createBrowserClient();
  try {
    const result = (await client.send("Target.createTarget", { url })) as { targetId: string };
    return { targetId: result.targetId };
  } finally {
    client.close();
  }
}

export async function closeTab(targetId: string): Promise<{ success: boolean }> {
  const client = await createBrowserClient();
  try {
    const result = (await client.send("Target.closeTarget", { targetId })) as { success: boolean };
    return { success: result.success };
  } finally {
    client.close();
  }
}

export async function focusTab(targetId: string): Promise<void> {
  const client = await createBrowserClient();
  try {
    await client.send("Target.activateTarget", { targetId });
  } finally {
    client.close();
  }
}

export async function navigate(url: string, _targetId?: string): Promise<{ url: string }> {
  const client = await createBrowserClient();
  try {
    await client.send("Page.enable", {});
    await client.send("Page.navigate", { url });
    // Wait a bit for navigation
    await new Promise((r) => setTimeout(r, 500));
    return { url };
  } finally {
    client.close();
  }
}

export async function screenshot(opts?: {
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
}): Promise<Buffer> {
  const client = await createBrowserClient();
  try {
    await client.send("Page.enable", {});

    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (opts?.fullPage) {
      const metrics = (await client.send("Page.getLayoutMetrics")) as {
        cssContentSize?: { width?: number; height?: number };
        contentSize?: { width?: number; height?: number };
      };
      const size = metrics?.cssContentSize ?? metrics?.contentSize;
      const width = Number(size?.width ?? 0);
      const height = Number(size?.height ?? 0);
      if (width > 0 && height > 0) {
        clip = { x: 0, y: 0, width, height, scale: 1 };
      }
    }

    const format = opts?.format ?? "png";
    const quality =
      format === "jpeg" ? Math.max(0, Math.min(100, Math.round(opts?.quality ?? 85))) : undefined;

    const result = (await client.send("Page.captureScreenshot", {
      format,
      ...(quality !== undefined ? { quality } : {}),
      fromSurface: true,
      captureBeyondViewport: true,
      ...(clip ? { clip } : {}),
    })) as { data?: string };

    if (!result?.data) {
      throw new Error("Screenshot failed: missing data");
    }
    return Buffer.from(result.data, "base64");
  } finally {
    client.close();
  }
}

export async function evaluate(expression: string): Promise<{
  result: unknown;
  error?: string;
}> {
  const client = await createBrowserClient();
  try {
    await client.send("Runtime.enable", {});
    const result = (await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })) as {
      result?: { value?: unknown; type?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };

    if (result.exceptionDetails) {
      return {
        result: undefined,
        error:
          result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "Evaluation failed",
      };
    }
    return { result: result.result?.value };
  } finally {
    client.close();
  }
}

export async function getPageInfo(): Promise<{
  url: string;
  title: string;
}> {
  const result = await evaluate(
    `JSON.stringify({ url: location.href, title: document.title })`
  );
  if (result.error) {
    throw new Error(result.error);
  }
  return JSON.parse(result.result as string);
}
