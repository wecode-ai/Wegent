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
const DEFAULT_DIRECT_CDP_PORT = 9225;
const DEFAULT_BROWSER_PREFIX = path.join(os.homedir(), ".wegent-executor", "browser");

function getBrowserPrefix(): string {
  return process.env.BROWSER_PREFIX || DEFAULT_BROWSER_PREFIX;
}

function getTokenFilePath(): string {
  return path.join(getBrowserPrefix(), ".token");
}

function getActiveTargetFilePath(): string {
  return path.join(getBrowserPrefix(), ".active-target");
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

function getDirectCdpPort(): number {
  const envPort = process.env.BROWSER_DIRECT_CDP_PORT;
  if (envPort) {
    const port = parseInt(envPort, 10);
    if (!isNaN(port) && port > 0 && port < 65536) return port;
  }
  return DEFAULT_DIRECT_CDP_PORT;
}

function getDirectCdpBaseUrl(): string {
  return `http://127.0.0.1:${getDirectCdpPort()}`;
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

function getActiveTargetId(): string | null {
  try {
    const value = fs.readFileSync(getActiveTargetFilePath(), "utf-8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function setActiveTargetId(targetId: string | null): void {
  try {
    fs.mkdirSync(getBrowserPrefix(), { recursive: true });
    if (targetId) {
      fs.writeFileSync(getActiveTargetFilePath(), targetId, "utf-8");
    } else {
      fs.rmSync(getActiveTargetFilePath(), { force: true });
    }
  } catch {}
}

export type RelayStatus = {
  relayRunning: boolean;
  extensionConnected: boolean;
  directConnected: boolean;
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
      const directTargets = await getDirectCdpTargets();
      return {
        relayRunning: false,
        extensionConnected: false,
        directConnected: directTargets.length > 0,
        targets: directTargets,
      };
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

    let directConnected = false;
    if (!extensionConnected) {
      targets = await getDirectCdpTargets();
      directConnected = targets.length > 0;
    }

    return { relayRunning: true, extensionConnected, directConnected, targets };
  } catch {
    const targets = await getDirectCdpTargets().catch(() => []);
    return {
      relayRunning: false,
      extensionConnected: false,
      directConnected: targets.length > 0,
      targets,
    };
  }
}

export type BrowserClient = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
};

async function getDirectCdpTargets(): Promise<
  Array<{ targetId: string; title: string; url: string }>
> {
  try {
    const res = await fetch(`${getDirectCdpBaseUrl()}/json/list`);
    if (!res.ok) return [];
    const targets = (await res.json()) as TargetInfo[];
    return targets
      .filter((target) => target.type === "page")
      .map((target) => ({
        targetId: target.id,
        title: target.title,
        url: target.url,
      }));
  } catch {
    return [];
  }
}

function normalizeConnectError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (
    lower.includes("unexpected server response: 409") ||
    lower.includes("extension_not_connected")
  ) {
    return new Error(
      "Browser extension not connected. Click extension icon on a tab to attach."
    );
  }
  return err instanceof Error ? err : new Error(message);
}

export async function createBrowserClient(opts?: {
  skipStatusCheck?: boolean;
}): Promise<BrowserClient> {
  const port = getRelayPort();
  const token = getAuthToken();

  if (!token) {
    return createDirectBrowserClient();
  }

  const status = await getStatus();
  if (status.directConnected && !status.extensionConnected) {
    return createDirectBrowserClient();
  }

  if (!opts?.skipStatusCheck) {
    if (!status.relayRunning) {
      if (status.directConnected) {
        return createDirectBrowserClient();
      }
      throw new Error("Relay server not running. Start it with: cd ~/dev/git/browser/relay-server && npm start");
    }
    if (!status.extensionConnected) {
      return createDirectBrowserClient();
    }
  }

  const wsUrl = `ws://127.0.0.1:${port}/cdp`;
  const ws = new WebSocket(wsUrl, {
    headers: { "x-cdp-relay-token": token },
    handshakeTimeout: 5000,
  });

  let nextId = 1;
  const pending = new Map<number, Pending>();

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
  } catch (err) {
    try {
      ws.close();
    } catch {}
    throw normalizeConnectError(err);
  }

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

async function createDirectBrowserClient(): Promise<BrowserClient> {
  const versionRes = await fetch(`${getDirectCdpBaseUrl()}/json/version`);
  if (!versionRes.ok) {
    throw new Error("Direct Chrome CDP endpoint is not running");
  }
  const version = (await versionRes.json()) as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Direct Chrome CDP endpoint did not expose a browser websocket");
  }

  const ws = new WebSocket(version.webSocketDebuggerUrl, { handshakeTimeout: 5000 });
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let attachedSessionId: string | null = null;
  let attachedTargetId: string | null = null;

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

  const rawSend = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> => {
    if (ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Connection not open"));
    }
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const ensureAttachedSession = async (): Promise<string> => {
    const targetInfos = ((await rawSend("Target.getTargets")) as {
      targetInfos?: Array<{ targetId: string; type: string; title?: string; url?: string }>;
    }).targetInfos ?? [];
    const activeTargetId = getActiveTargetId();
    const pageTargets = targetInfos.filter((target) => target.type === "page");
    const target =
      pageTargets.find((item) => item.targetId === activeTargetId) ??
      pageTargets.find((item) => item.url && !item.url.startsWith("chrome://")) ??
      pageTargets[0];
    if (!target) {
      throw new Error("No page target available in direct Chrome CDP");
    }
    if (attachedSessionId && attachedTargetId === target.targetId) {
      return attachedSessionId;
    }
    const attached = (await rawSend("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId?: string };
    if (!attached.sessionId) {
      throw new Error("Failed to attach to direct Chrome target");
    }
    attachedSessionId = attached.sessionId;
    attachedTargetId = target.targetId;
    setActiveTargetId(target.targetId);
    return attached.sessionId;
  };

  const send = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method.startsWith("Target.")) {
      return rawSend(method, params);
    }
    const sessionId = await ensureAttachedSession();
    return rawSend(method, params, sessionId);
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

export async function openTab(
  url: string,
  opts?: { client?: BrowserClient }
): Promise<{ targetId: string }> {
  const client = opts?.client ?? (await createBrowserClient());
  const ownsClient = !opts?.client;
  try {
    const result = (await client.send("Target.createTarget", { url })) as { targetId: string };
    setActiveTargetId(result.targetId);
    return { targetId: result.targetId };
  } finally {
    if (ownsClient) {
      client.close();
    }
  }
}

export async function closeTab(
  targetId: string,
  opts?: { client?: BrowserClient }
): Promise<{ success: boolean }> {
  const client = opts?.client ?? (await createBrowserClient());
  const ownsClient = !opts?.client;
  try {
    const result = (await client.send("Target.closeTarget", { targetId })) as { success: boolean };
    if (result.success && getActiveTargetId() === targetId) {
      setActiveTargetId(null);
    }
    return { success: result.success };
  } finally {
    if (ownsClient) {
      client.close();
    }
  }
}

export async function focusTab(targetId: string, opts?: { client?: BrowserClient }): Promise<void> {
  const client = opts?.client ?? (await createBrowserClient());
  const ownsClient = !opts?.client;
  try {
    await client.send("Target.activateTarget", { targetId });
    setActiveTargetId(targetId);
  } finally {
    if (ownsClient) {
      client.close();
    }
  }
}

export async function navigate(
  url: string,
  _targetId?: string,
  opts?: { client?: BrowserClient }
): Promise<{ url: string }> {
  const client = opts?.client ?? (await createBrowserClient());
  const ownsClient = !opts?.client;
  try {
    await client.send("Page.enable", {});
    await client.send("Page.navigate", { url });
    // Wait a bit for navigation
    await new Promise((r) => setTimeout(r, 500));
    return { url };
  } finally {
    if (ownsClient) {
      client.close();
    }
  }
}

export async function screenshot(opts?: {
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
  client?: BrowserClient;
}): Promise<Buffer> {
  const client = opts?.client ?? (await createBrowserClient());
  const ownsClient = !opts?.client;
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
    if (ownsClient) {
      client.close();
    }
  }
}

export async function evaluate(
  expression: string,
  opts?: { client?: BrowserClient }
): Promise<{
  result: unknown;
  error?: string;
}> {
  const client = opts?.client ?? (await createBrowserClient());
  const ownsClient = !opts?.client;
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
    if (ownsClient) {
      client.close();
    }
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
