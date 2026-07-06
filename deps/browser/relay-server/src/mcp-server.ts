#!/usr/bin/env node
/**
 * MCP server exposing the Wework built-in browser with Codex browser_* tools.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { ensureRelayServer } from "./relay-server.js";
import { executeBrowserTool, type BrowserToolParams } from "./tool.js";

const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";
const DEFAULT_EMBEDDED_BROWSER_BRIDGE_URL = "http://127.0.0.1:9231";
const DEFAULT_BROWSER_PREFIX = path.join(os.homedir(), ".wegent-executor", "browser");
const EMBEDDED_BROWSER_TARGET = "embedded";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

function browserPrefix(): string {
  return process.env.BROWSER_PREFIX || DEFAULT_BROWSER_PREFIX;
}

function relayUrl(): string {
  return process.env.BROWSER_RELAY_URL || DEFAULT_RELAY_URL;
}

function embeddedBrowserBridgeUrl(): string {
  return process.env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL || DEFAULT_EMBEDDED_BROWSER_BRIDGE_URL;
}

function browserTarget(): string {
  return process.env.WEWORK_BROWSER_MCP_TARGET || "";
}

function shouldUseEmbeddedBrowser(): boolean {
  return browserTarget() === EMBEDDED_BROWSER_TARGET;
}

function writeRelayToken(token: string): void {
  const tokenPath = path.join(browserPrefix(), ".token");
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token, "utf-8");
}

function readRelayToken(): string | null {
  try {
    const token = fs.readFileSync(path.join(browserPrefix(), ".token"), "utf-8").trim();
    return token || null;
  } catch {
    return null;
  }
}

async function isRelayRunning(): Promise<boolean> {
  try {
    const response = await fetch(relayUrl(), { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureRelay(): Promise<void> {
  if ((await isRelayRunning()) && readRelayToken()) {
    return;
  }
  const relay = await ensureRelayServer({ cdpUrl: relayUrl() });
  writeRelayToken(relay.authToken);
}

type EmbeddedBrowserBridgeResponse = {
  ok?: boolean;
  data?: unknown;
  error?: string;
};

type EmbeddedBrowserBridgePayload = {
  action: string;
  url?: string;
  expression?: string;
  selector?: string;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  timeoutMs?: number;
  label?: string;
};

function embeddedBrowserLabel(): string | undefined {
  const label = process.env.WEWORK_EMBEDDED_BROWSER_LABEL?.trim();
  return label || undefined;
}

async function callEmbeddedBrowserBridge(
  payload: EmbeddedBrowserBridgePayload
): Promise<EmbeddedBrowserBridgeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${embeddedBrowserBridgeUrl()}/browser`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, label: payload.label ?? embeddedBrowserLabel() }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `Embedded browser bridge returned HTTP ${response.status}` };
    }
    return (await response.json()) as EmbeddedBrowserBridgeResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Embedded browser bridge is unavailable at ${embeddedBrowserBridgeUrl()}: ${message}. Open the Wework browser tab before using browser tools.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function embeddedBrowserStatus(): Promise<EmbeddedBrowserBridgeResponse> {
  try {
    const label = embeddedBrowserLabel();
    if (label) {
      return callEmbeddedBrowserBridge({ action: "status", label });
    }
    const response = await fetch(`${embeddedBrowserBridgeUrl()}/status`, { method: "GET" });
    if (!response.ok) {
      return { ok: false, error: `Embedded browser bridge returned HTTP ${response.status}` };
    }
    return (await response.json()) as EmbeddedBrowserBridgeResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Embedded browser bridge is unavailable: ${message}` };
  }
}

function embeddedBridgeResult(result: EmbeddedBrowserBridgeResponse): Record<string, unknown> {
  if (!result.ok) {
    return textToolResult(result.error || "Embedded browser tool failed", true);
  }
  return textToolResult(result.data ?? { ok: true });
}

function expressionSelector(ref: string | undefined): string | undefined {
  if (!ref) {
    return undefined;
  }
  if (ref.startsWith("css=")) {
    return ref.slice(4);
  }
  return ref;
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string");
}

function formFieldsParam(params: Record<string, unknown>): Array<{ ref: string; value: string }> {
  const value = params.fields;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const field = item as Record<string, unknown>;
    const ref = typeof field.ref === "string" ? field.ref : "";
    const fieldValue = typeof field.value === "string" ? field.value : "";
    return ref ? [{ ref, value: fieldValue }] : [];
  });
}

function refParam(params: Record<string, unknown>): string | undefined {
  return stringParam(params, "ref") || stringParam(params, "element");
}

function evaluateExpression(params: Record<string, unknown>): string | undefined {
  const expression = stringParam(params, "expression");
  if (expression) {
    return expression;
  }
  const fn = stringParam(params, "function") || stringParam(params, "fn");
  if (!fn) {
    return undefined;
  }
  return fn.trim().startsWith("(") || fn.trim().startsWith("async")
    ? `(${fn})()`
    : fn;
}

function textToolResult(data: unknown, isError = false): Record<string, unknown> {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = []
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: true,
    },
  };
}

const tools: ToolDefinition[] = [
  tool(
    "browser_navigate",
    "Navigate the Wework built-in browser to a URL.",
    { url: { type: "string" } },
    ["url"]
  ),
  tool(
    "browser_snapshot",
    "Capture an accessibility snapshot of the current Wework browser page.",
    {
      interactive: { type: "boolean" },
      compact: { type: "boolean" },
    }
  ),
  tool(
    "browser_click",
    "Click an element in the Wework built-in browser from the latest snapshot.",
    {
      ref: { type: "string" },
      element: { type: "string" },
      button: { type: "string" },
      doubleClick: { type: "boolean" },
    }
  ),
  tool(
    "browser_click_coordinates",
    "Click viewport coordinates in the current Wework browser page.",
    {
      x: { type: "number" },
      y: { type: "number" },
      button: { type: "string" },
      doubleClick: { type: "boolean" },
    },
    ["x", "y"]
  ),
  tool(
    "browser_type",
    "Type text into an element in the Wework built-in browser from the latest snapshot.",
    {
      ref: { type: "string" },
      element: { type: "string" },
      text: { type: "string" },
      submit: { type: "boolean" },
      slowly: { type: "boolean" },
    },
    ["text"]
  ),
  tool(
    "browser_fill_form",
    "Fill multiple form fields in the Wework built-in browser from latest snapshot refs.",
    {
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref: { type: "string" },
            value: { type: "string" },
          },
          required: ["ref", "value"],
          additionalProperties: true,
        },
      },
    },
    ["fields"]
  ),
  tool(
    "browser_press_key",
    "Press a keyboard key in the Wework built-in browser.",
    { key: { type: "string" } },
    ["key"]
  ),
  tool(
    "browser_hover",
    "Hover an element in the Wework built-in browser from the latest snapshot.",
    {
      ref: { type: "string" },
      element: { type: "string" },
    }
  ),
  tool("browser_scroll", "Scroll the Wework browser page or an element from the latest snapshot.", {
    ref: { type: "string" },
    element: { type: "string" },
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    amount: { type: "number" },
  }),
  tool(
    "browser_scroll_into_view",
    "Scroll an element from the latest Wework browser snapshot into view.",
    {
      ref: { type: "string" },
      element: { type: "string" },
    }
  ),
  tool("browser_select_option", "Select one or more option values in the Wework built-in browser.", {
    ref: { type: "string" },
    element: { type: "string" },
    values: { type: "array", items: { type: "string" } },
  }),
  tool("browser_drag", "Drag from one Wework browser snapshot element to another.", {
    startRef: { type: "string" },
    endRef: { type: "string" },
  }),
  tool("browser_wait_for", "Wait for Wework browser page state, text, selector, URL, or a JavaScript condition.", {
    time: { type: "number" },
    timeMs: { type: "number" },
    text: { type: "string" },
    textGone: { type: "string" },
    selector: { type: "string" },
    url: { type: "string" },
    loadState: { type: "string" },
    fn: { type: "string" },
    timeoutMs: { type: "number" },
  }),
  tool("browser_resize", "Resize the Wework built-in browser viewport.", {
    width: { type: "number" },
    height: { type: "number" },
  }),
  tool(
    "browser_take_screenshot",
    "Capture a Wework browser page or element screenshot and return the local path.",
    {
      fullPage: { type: "boolean" },
      ref: { type: "string" },
      element: { type: "string" },
      type: { type: "string", enum: ["png", "jpeg"] },
    }
  ),
  tool("browser_evaluate", "Evaluate JavaScript in the Wework browser page.", {
    expression: { type: "string" },
    function: { type: "string" },
    fn: { type: "string" },
  }),
  tool("browser_tab_list", "List Wework built-in browser tabs."),
  tool(
    "browser_tab_new",
    "Open a new Wework built-in browser tab.",
    { url: { type: "string" } },
    ["url"]
  ),
  tool("browser_tab_select", "Focus a Wework built-in browser tab by targetId.", {
    targetId: { type: "string" },
    index: { type: "number" },
  }),
  tool("browser_tab_close", "Close a Wework built-in browser tab by targetId or index.", {
    targetId: { type: "string" },
    index: { type: "number" },
  }),
];

async function callBrowser(params: BrowserToolParams): Promise<Record<string, unknown>> {
  if (shouldUseEmbeddedBrowser()) {
    return callEmbeddedBrowser(params);
  }
  await ensureRelay();
  const result = await executeBrowserTool(params);
  if (!result.ok) {
    return textToolResult(result.error || "Browser tool failed", true);
  }
  return textToolResult(result.data ?? { ok: true });
}

async function callEmbeddedBrowser(params: BrowserToolParams): Promise<Record<string, unknown>> {
  switch (params.action) {
    case "navigate":
    case "open":
      return embeddedBridgeResult(
        await callEmbeddedBrowserBridge({
          action: "navigate",
          url: "url" in params && typeof params.url === "string" ? params.url : undefined,
        })
      );
    case "evaluate":
      return embeddedBridgeResult(
        await callEmbeddedBrowserBridge({
          action: "evaluate",
          expression:
            "expression" in params && typeof params.expression === "string"
              ? params.expression
              : undefined,
        })
      );
    case "tabs": {
      const status = await embeddedBrowserStatus();
      if (!status.ok) {
        return embeddedBridgeResult(status);
      }
      const pageState = await callEmbeddedBrowserBridge({ action: "pageState" });
      const data = {
        tabs: [
          {
            targetId: "embedded",
            title: pageState.ok
              ? (pageState.data as { title?: string } | undefined)?.title
              : "Wework Browser",
            url: pageState.ok ? (pageState.data as { url?: string } | undefined)?.url : undefined,
            attached: true,
            label: embeddedBrowserLabel(),
          },
        ],
      };
      return textToolResult(data);
    }
    case "focus":
      return textToolResult({ ok: true, targetId: "embedded" });
    case "close":
      return textToolResult("Embedded browser tabs are managed by the Wework right panel.", true);
    case "screenshot":
      return embeddedBridgeResult(await callEmbeddedBrowserBridge({ action: "screenshot" }));
    case "snapshot":
      return embeddedBridgeResult(
        await callEmbeddedBrowserBridge({
          action: "evaluate",
          expression:
            "({ title: document.title, url: location.href, text: document.body?.innerText?.slice(0, 12000) || '' })",
        })
      );
    case "act":
      return callEmbeddedBrowserAction(params.request as Record<string, unknown> | undefined);
    default:
      return textToolResult(`Unsupported embedded browser action: ${String(params.action)}`, true);
  }
}

async function callEmbeddedBrowserAction(
  request: Record<string, unknown> | undefined
): Promise<Record<string, unknown>> {
  const kind = typeof request?.kind === "string" ? request.kind : "";
  switch (kind) {
    case "click":
    case "hover":
    case "scrollIntoView":
      return embeddedBridgeResult(
        await callEmbeddedBrowserBridge({
          action: kind === "click" ? "click" : "evaluate",
          selector: expressionSelector(typeof request?.ref === "string" ? request.ref : undefined),
          expression:
            kind === "hover"
              ? `document.querySelector(${JSON.stringify(expressionSelector(typeof request?.ref === "string" ? request.ref : "") || "")})?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`
              : `document.querySelector(${JSON.stringify(expressionSelector(typeof request?.ref === "string" ? request.ref : "") || "")})?.scrollIntoView({ block: 'center', inline: 'center' })`,
        })
      );
    case "clickAt":
      return embeddedBridgeResult(
        await callEmbeddedBrowserBridge({
          action: "click",
          x: typeof request?.x === "number" ? request.x : 0,
          y: typeof request?.y === "number" ? request.y : 0,
        })
      );
    case "type":
      return embeddedBridgeResult(
        await callEmbeddedBrowserBridge({
          action: "typeText",
          selector: expressionSelector(typeof request?.ref === "string" ? request.ref : undefined),
          text: typeof request?.text === "string" ? request.text : "",
        })
      );
    case "press":
      return embeddedBridgeResult(
        await callEmbeddedBrowserBridge({
          action: "press",
          key: typeof request?.key === "string" ? request.key : "",
        })
      );
    case "wait":
      return embeddedBridgeResult(
        await callEmbeddedBrowserBridge({
          action: "waitFor",
          text: typeof request?.text === "string" ? request.text : undefined,
          selector: typeof request?.selector === "string" ? request.selector : undefined,
          url: typeof request?.url === "string" ? request.url : undefined,
          expression: typeof request?.fn === "string" ? request.fn : undefined,
          timeoutMs: typeof request?.timeoutMs === "number" ? request.timeoutMs : undefined,
        })
      );
    case "scroll":
      return embeddedBridgeResult(
        await callEmbeddedBrowserBridge({
          action: "evaluate",
          expression: `window.scrollBy(0, ${request?.direction === "up" ? -1 : 1} * ${typeof request?.amount === "number" ? request.amount : 500}), true`,
        })
      );
    case "resize":
      return textToolResult("Embedded browser size follows the Wework right panel bounds.");
    default:
      return textToolResult(`Unsupported embedded browser interaction: ${kind}`, true);
  }
}

async function targetIdFromIndex(index: number): Promise<string | undefined> {
  if (shouldUseEmbeddedBrowser()) {
    return index === 0 ? "embedded" : undefined;
  }
  await ensureRelay();
  const result = await executeBrowserTool({ action: "tabs" });
  if (!result.ok) {
    return undefined;
  }
  const tabs = (result.data as { tabs?: Array<{ targetId?: string }> } | undefined)?.tabs ?? [];
  return tabs[index]?.targetId;
}

async function targetIdParam(params: Record<string, unknown>): Promise<string | undefined> {
  const targetId = stringParam(params, "targetId");
  if (targetId) {
    return targetId;
  }
  const index = numberParam(params, "index");
  return index === undefined ? undefined : targetIdFromIndex(index);
}

async function executeTool(name: string, rawParams: unknown): Promise<Record<string, unknown>> {
  const params = objectParams(rawParams);
  switch (name) {
    case "browser_navigate":
      return callBrowser({ action: "navigate", url: stringParam(params, "url") });
    case "browser_snapshot":
      return callBrowser({
        action: "snapshot",
        interactive: boolParam(params, "interactive") ?? true,
        compact: boolParam(params, "compact"),
      });
    case "browser_click":
      return callBrowser({
        action: "act",
        request: {
          kind: "click",
          ref: refParam(params) ?? "",
          button: stringParam(params, "button"),
          doubleClick: boolParam(params, "doubleClick"),
        },
      });
    case "browser_click_coordinates":
      return callBrowser({
        action: "act",
        request: {
          kind: "clickAt",
          x: numberParam(params, "x") ?? 0,
          y: numberParam(params, "y") ?? 0,
          button: stringParam(params, "button"),
          doubleClick: boolParam(params, "doubleClick"),
        },
      });
    case "browser_type":
      return callBrowser({
        action: "act",
        request: {
          kind: "type",
          ref: refParam(params) ?? "",
          text: stringParam(params, "text") ?? "",
          submit: boolParam(params, "submit"),
          slowly: boolParam(params, "slowly"),
        },
      });
    case "browser_fill_form":
      return callBrowser({ action: "act", request: { kind: "fill", fields: formFieldsParam(params) } });
    case "browser_press_key":
      return callBrowser({ action: "act", request: { kind: "press", key: stringParam(params, "key") ?? "" } });
    case "browser_hover":
      return callBrowser({ action: "act", request: { kind: "hover", ref: refParam(params) ?? "" } });
    case "browser_scroll":
      return callBrowser({
        action: "act",
        request: {
          kind: "scroll",
          ref: refParam(params),
          direction: stringParam(params, "direction") as "up" | "down" | "left" | "right" | undefined,
          amount: numberParam(params, "amount"),
        },
      });
    case "browser_scroll_into_view":
      return callBrowser({ action: "act", request: { kind: "scrollIntoView", ref: refParam(params) ?? "" } });
    case "browser_select_option":
      return callBrowser({
        action: "act",
        request: {
          kind: "select",
          ref: refParam(params) ?? "",
          values: stringArrayParam(params, "values") ?? [],
        },
      });
    case "browser_drag":
      return callBrowser({
        action: "act",
        request: {
          kind: "drag",
          startRef: stringParam(params, "startRef") ?? "",
          endRef: stringParam(params, "endRef") ?? "",
        },
      });
    case "browser_wait_for":
      return callBrowser({
        action: "act",
        request: {
          kind: "wait",
          timeMs: numberParam(params, "timeMs") ?? numberParam(params, "time"),
          text: stringParam(params, "text"),
          textGone: stringParam(params, "textGone"),
          selector: stringParam(params, "selector"),
          url: stringParam(params, "url"),
          loadState: stringParam(params, "loadState") as "load" | "domcontentloaded" | "networkidle" | undefined,
          fn: stringParam(params, "fn"),
          timeoutMs: numberParam(params, "timeoutMs"),
        },
      });
    case "browser_resize":
      return callBrowser({
        action: "act",
        request: {
          kind: "resize",
          width: numberParam(params, "width") ?? 1280,
          height: numberParam(params, "height") ?? 720,
        },
      });
    case "browser_take_screenshot":
      return callBrowser({
        action: "screenshot",
        fullPage: boolParam(params, "fullPage"),
        ref: stringParam(params, "ref"),
        element: stringParam(params, "element"),
        type: stringParam(params, "type") === "jpeg" ? "jpeg" : "png",
      });
    case "browser_evaluate":
      return callBrowser({ action: "evaluate", expression: evaluateExpression(params) });
    case "browser_tab_list":
      return callBrowser({ action: "tabs" });
    case "browser_tab_new":
      return callBrowser({ action: "open", url: stringParam(params, "url") });
    case "browser_tab_select": {
      const targetId = await targetIdParam(params);
      return targetId
        ? callBrowser({ action: "focus", targetId })
        : textToolResult("browser_tab_select requires targetId or index", true);
    }
    case "browser_tab_close": {
      const targetId = await targetIdParam(params);
      return targetId
        ? callBrowser({ action: "close", targetId })
        : textToolResult("browser_tab_close requires targetId or index", true);
    }
    default:
      return textToolResult(`Unknown tool: ${name}`, true);
  }
}

function writeMessage(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeResult(id: JsonRpcId | undefined, result: Record<string, unknown>): void {
  if (id === undefined) {
    return;
  }
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id: JsonRpcId | undefined, code: number, message: string): void {
  if (id === undefined) {
    return;
  }
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  switch (request.method) {
    case "initialize":
      writeResult(request.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wegent-cdp-browser", version: "0.1.0" },
      });
      break;
    case "notifications/initialized":
      break;
    case "tools/list":
      writeResult(request.id, { tools });
      break;
    case "tools/call": {
      const params = objectParams(request.params);
      const name = stringParam(params, "name");
      if (!name) {
        writeError(request.id, -32602, "tools/call requires params.name");
        return;
      }
      const result = await executeTool(name, params.arguments);
      writeResult(request.id, result);
      break;
    }
    case "ping":
      writeResult(request.id, {});
      break;
    default:
      writeError(request.id, -32601, `Unknown method: ${request.method ?? ""}`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

async function processLine(line: string): Promise<void> {
  let request: JsonRpcRequest | undefined;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
    await handleRequest(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[browser-mcp-server] ${message}`);
    writeError(request?.id, -32603, message);
  }
}

let requestQueue = Promise.resolve();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  requestQueue = requestQueue.then(
    () => processLine(trimmed),
    () => processLine(trimmed)
  );
});
