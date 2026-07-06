import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { test } from "node:test";

function callMcpServer(messages, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/mcp-server.js"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`MCP server exited with ${code}: ${stderr.join("")}`));
        return;
      }
      resolve(
        stdout
          .join("")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      );
    });

    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    child.stdin.end();
  });
}

function withEmbeddedBridge(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    if (request.url === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, data: { open: true, label: "workspace-browser" } }));
      return;
    }

    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(body || "{}");
      requests.push(payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, data: { echoed: payload } }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        resolve(await handler(`http://127.0.0.1:${port}`, requests));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

test("MCP server exposes Codex-compatible browser tools over stdio JSON-RPC", async () => {
  const responses = await callMcpServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);

  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].result.serverInfo.name, "wegent-cdp-browser");
  assert.equal(responses[1].id, 2);

  const toolNames = responses[1].result.tools.map((tool) => tool.name);
  assert.deepEqual(
    [
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_click_coordinates",
      "browser_type",
      "browser_fill_form",
      "browser_press_key",
      "browser_hover",
      "browser_scroll",
      "browser_scroll_into_view",
      "browser_select_option",
      "browser_drag",
      "browser_wait_for",
      "browser_resize",
      "browser_take_screenshot",
      "browser_evaluate",
      "browser_tab_list",
      "browser_tab_new",
      "browser_tab_select",
      "browser_tab_close",
    ].filter((name) => !toolNames.includes(name)),
    []
  );

  const toolsByName = new Map(responses[1].result.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(toolsByName.get("browser_click").inputSchema.required, []);
  assert.deepEqual(toolsByName.get("browser_type").inputSchema.required, ["text"]);
  assert.deepEqual(toolsByName.get("browser_click_coordinates").inputSchema.required, ["x", "y"]);
  assert.deepEqual(toolsByName.get("browser_fill_form").inputSchema.required, ["fields"]);
});

test("MCP server returns JSON-RPC errors with the original request id", async () => {
  const responses = await callMcpServer([
    { jsonrpc: "2.0", id: "bad-call", method: "tools/call", params: {} },
  ]);

  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, "bad-call");
  assert.equal(responses[0].error.code, -32602);
});

test("MCP server controls the embedded Wework browser in embedded target mode", async () => {
  await withEmbeddedBridge(async (bridgeUrl, requests) => {
    const responses = await callMcpServer(
      [
        {
          jsonrpc: "2.0",
          id: "tabs",
          method: "tools/call",
          params: {
            name: "browser_tab_list",
            arguments: {},
          },
        },
        {
          jsonrpc: "2.0",
          id: "nav",
          method: "tools/call",
          params: {
            name: "browser_navigate",
            arguments: { url: "https://example.com/" },
          },
        },
        {
          jsonrpc: "2.0",
          id: "eval",
          method: "tools/call",
          params: {
            name: "browser_evaluate",
            arguments: { expression: "document.title" },
          },
        },
        {
          jsonrpc: "2.0",
          id: "screenshot",
          method: "tools/call",
          params: {
            name: "browser_take_screenshot",
            arguments: {},
          },
        },
      ],
      {
        WEWORK_BROWSER_MCP_TARGET: "embedded",
        WEWORK_EMBEDDED_BROWSER_BRIDGE_URL: bridgeUrl,
      }
    );

    assert.equal(responses.length, 4);
    assert.equal(responses[0].id, "tabs");
    assert.match(responses[0].result.content[0].text, /embedded/);
    assert.equal(responses[1].id, "nav");
    assert.equal(responses[2].id, "eval");
    assert.equal(responses[3].id, "screenshot");
    assert.deepEqual(requests, [
      { action: "pageState" },
      { action: "navigate", url: "https://example.com/" },
      { action: "evaluate", expression: "document.title" },
      { action: "screenshot" },
    ]);
  });
});
