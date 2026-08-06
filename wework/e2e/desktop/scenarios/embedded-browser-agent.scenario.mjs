import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const RIGHT_PANEL_TOGGLE_SELECTOR =
  '[data-workspace-tab-portal-owner]:not([hidden]) [data-testid="toggle-right-workspace-panel-button"]'
const RIGHT_BROWSER_OPTION_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-browser-option"]`
const BROWSER_INPUT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-url-input"]`
const BROWSER_AGENT_STATUS_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-agent-status"]`
const BROWSER_AGENT_PAUSE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-agent-pause-button"]`
const BROWSER_AGENT_RESUME_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-agent-resume-button"]`
const BROWSER_AGENT_APPROVE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-agent-approval-approve-button"]`
const TRANSIENT_NOTICE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="transient-notice"]`
const BROWSER_LABEL = 'workspace-browser'
const FIXTURE_PATH = '/embedded-browser-agent-fixture'
const REDIRECT_PATH = '/embedded-browser-agent-redirect'
const BRIDGE_RUNTIME_FILE = 'embedded-browser-bridge.json'
const READY_TEXT = 'Embedded Browser Agent Fixture'
const FILLED_TEXT = 'filled: Alpha Beta'
const CLICKED_TEXT = 'clicked: Alpha Beta'
const DIRECT_FILLED_TEXT = 'filled: Gamma Delta'
const DIRECT_CLICKED_TEXT = 'clicked: Gamma Delta'
const DIRECT_DELETED_TEXT = 'deleted: Gamma Delta'
const HOVER_TEXT = 'hovered'
const SELECT_TEXT = 'selected: finance'
const CHECKED_TEXT = 'checked: true'
const SCROLLED_TEXT = 'scroll marker visible'
const LOCAL_FILE_TEXT = 'Local File Browser Fixture'
const LOCAL_MARKDOWN_TEXT = 'Local Markdown Browser Fixture'
const LOCAL_PLAINTEXT_TEXT = '中文无扩展名文本'
const LOCAL_TOAST_TEXT = '此文件无法预览'
const LOCAL_DIRECTORY_TEXT = 'local-directory-readme.txt'
const BROWSER_DATA_COOKIE_PATH = '/embedded-browser-data-cookie-fixture'
const BROWSER_DATA_CACHE_PATH = '/embedded-browser-data-cache-fixture'
const BROWSER_DATA_CACHE_RESOURCE_PATH = '/embedded-browser-data-cache-resource.js'
const BROWSER_MORE_BUTTON_SELECTOR = '[data-testid="workspace-browser-more-button"]'
const BROWSER_CLEAR_DATA_SELECTOR = '[data-testid="workspace-browser-clear-data-item"]'
const BROWSER_CLEAR_COOKIES_SELECTOR = '[data-testid="workspace-browser-clear-cookies-item"]'
const BROWSER_CLEAR_CACHE_SELECTOR = '[data-testid="workspace-browser-clear-cache-item"]'
const BROWSER_NATIVE_VIEW_SELECTOR = '[data-testid="workspace-browser-native-view"]'
const BROWSER_CLEAR_STARTED_TEXT = '开始清除浏览数据'
const BROWSER_CLEAR_COMPLETED_TEXT = '浏览数据已清除'
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(scriptDir, '..', '..', '..', '..')

function fixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${READY_TEXT}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 16px; }
      h1 { margin: 0 0 12px; font-size: 24px; }
      label, input, button, output, select { display: block; margin-block: 6px; }
      input, button, select { font: inherit; padding: 4px 6px; }
      #agent-confirm { display: inline; padding: 0; margin: 0 6px 0 0; }
      #agent-scroll-box { block-size: 120px; overflow: auto; border: 1px solid #ccc; padding: 8px; }
      #agent-scroll-spacer { block-size: 420px; }
    </style>
  </head>
  <body>
    <h1>${READY_TEXT}</h1>
    <label for="agent-name">Agent name</label>
    <input id="agent-name" name="agent-name" placeholder="Name" />
    <button id="agent-submit" type="button">Run agent form</button>
    <button id="agent-delete" type="button">Delete agent record</button>
    <button id="agent-hover" type="button">Hover target</button>
    <label for="agent-kind">Agent kind</label>
    <select id="agent-kind">
      <option value="general">General</option>
      <option value="finance">Finance</option>
    </select>
    <label><input id="agent-confirm" type="checkbox" aria-label="Confirm" /> Confirm</label>
    <div id="agent-scroll-box" role="region" aria-label="Scrollable results" tabindex="0">
      <div id="agent-scroll-spacer"></div>
      <div id="agent-scroll-marker">${SCROLLED_TEXT}</div>
    </div>
    <output id="agent-result" role="status">idle</output>
    <script>
      const input = document.getElementById('agent-name');
      const result = document.getElementById('agent-result');
      input.addEventListener('input', () => {
        result.textContent = 'filled: ' + input.value;
      });
      document.getElementById('agent-submit').addEventListener('click', () => {
        result.textContent = 'clicked: ' + input.value;
        document.body.dataset.clicked = 'true';
      });
      document.getElementById('agent-delete').addEventListener('click', () => {
        result.textContent = 'deleted: ' + input.value;
        document.body.dataset.deleted = 'true';
      });
      document.getElementById('agent-hover').addEventListener('mouseover', () => {
        result.textContent = '${HOVER_TEXT}';
      });
      document.getElementById('agent-kind').addEventListener('change', event => {
        result.textContent = 'selected: ' + event.target.value;
      });
      document.getElementById('agent-confirm').addEventListener('change', event => {
        result.textContent = 'checked: ' + event.target.checked;
      });
    </script>
  </body>
</html>`
}

function localFixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${LOCAL_FILE_TEXT}</title>
  </head>
  <body>
    <h1>${LOCAL_FILE_TEXT}</h1>
  </body>
</html>`
}

function browserDataCookieFixtureHtml() {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Browser data Cookie fixture</title></head>
  <body>
    <h1>Browser data Cookie fixture</h1>
    <script>document.cookie = 'wework_browser_data_e2e=present; Path=/';</script>
  </body>
</html>`
}

function browserDataCacheFixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Browser data cache fixture</title>
    <script src="${BROWSER_DATA_CACHE_RESOURCE_PATH}"></script>
  </head>
  <body><h1>Browser data cache fixture</h1></body>
</html>`
}

async function waitForBridgeIdentity(executorHome, timeoutMs) {
  const runtimePath = join(executorHome, 'runtime', BRIDGE_RUNTIME_FILE)
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const content = await readFile(runtimePath, 'utf8').catch(() => '')
    if (content) {
      const record = JSON.parse(content)
      if (record.schemaVersion === 1 && record.address && record.token) {
        return { baseUrl: `http://${record.address}`, token: record.token, runtimePath }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for authenticated embedded browser bridge runtime')
}

async function writeStaleBridgeRuntime(identity) {
  await writeFile(
    identity.runtimePath,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      address: '127.0.0.1:9',
      token: 'stale-upgrade-token',
      startedAtUnixMs: Date.now() - 60_000,
    })}\n`,
    'utf8'
  )
}

async function callBridge(identity, payload) {
  const response = await fetch(`${identity.baseUrl}/browser`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${identity.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ label: BROWSER_LABEL, ...payload }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, `Bridge HTTP failed: ${JSON.stringify(body)}`)
  assert.equal(body.ok, true, `Bridge action failed: ${JSON.stringify(body)}`)
  return body.data
}

async function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function waitForControlValue(control, selector, expected, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if ((await control.command('getValue', selector)) === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

async function withBrowserMcp(identity, callback) {
  const executorPath =
    process.env.WEWORK_E2E_EXECUTOR_BIN ||
    join(
      repoDir,
      'executor',
      'target',
      'debug',
      process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
    )
  const child = spawn(executorPath, ['browser-mcp-server'], {
    cwd: repoDir,
    env: {
      ...process.env,
      WEWORK_EMBEDDED_BROWSER_BRIDGE_URL: identity.baseUrl,
      WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN: identity.token,
      WEWORK_EMBEDDED_BROWSER_BRIDGE_RUNTIME_FILE: identity.runtimePath,
      WEWORK_EMBEDDED_BROWSER_LABEL: BROWSER_LABEL,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  const pending = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    }
  })

  let nextId = 1
  const request = (method, params = {}) => {
    const id = nextId++
    const response = new Promise((resolvePromise, reject) => {
      pending.set(id, { resolve: resolvePromise, reject })
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return withTimeout(response, 30_000, `Timed out waiting for MCP ${method}`)
  }
  const callTool = async (name, args = {}) => {
    const result = await request('tools/call', {
      name,
      arguments: { ...args, includeJson: true },
    })
    assert.equal(result.isError, false, `${name} returned error: ${JSON.stringify(result)}`)
    const text = result.content?.[0]?.text ?? ''
    assert.ok(text.trim(), `${name} returned empty text: ${JSON.stringify(result)}`)
    return text
  }

  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'embedded-browser-agent-e2e', version: '1.0.0' },
    })
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    )
    return await callback(callTool)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    assert.equal(stderr.includes('lifecycle=fatal'), false, stderr)
    assert.ok(
      stderr.includes(`bridge_url=${identity.baseUrl}`),
      `MCP server did not use the injected bridge URL. stderr:\n${stderr}`
    )
  }
}

function findNode(inspect, predicate, description) {
  const node = inspect.nodes.find(predicate)
  assert.ok(node, `${description} was not present in inspect result`)
  assert.ok(node.ref, `${description} did not have an inspect ref`)
  return node
}

function findReadonlyNode(inspect, predicate, description) {
  const node = inspect.nodes.find(predicate)
  assert.ok(node, `${description} was not present in inspect result`)
  return node
}

function parseToolJson(text) {
  const marker = 'JSON:\n'
  if (text.includes(marker)) {
    return JSON.parse(text.slice(text.indexOf(marker) + marker.length))
  }
  return JSON.parse(text)
}

export function createDesktopScenario({ executorHome, resultDir, uiTimeoutMs }) {
  let cacheResourceRequests = 0

  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === REDIRECT_PATH) {
        response.writeHead(302, { location: FIXTURE_PATH })
        response.end()
        return true
      }
      if (request.method === 'GET' && url.pathname === BROWSER_DATA_COOKIE_PATH) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(browserDataCookieFixtureHtml())
        return true
      }
      if (request.method === 'GET' && url.pathname === BROWSER_DATA_CACHE_PATH) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(browserDataCacheFixtureHtml())
        return true
      }
      if (request.method === 'GET' && url.pathname === BROWSER_DATA_CACHE_RESOURCE_PATH) {
        cacheResourceRequests += 1
        response.writeHead(200, {
          'cache-control': 'public, max-age=3600',
          'content-type': 'application/javascript; charset=utf-8',
        })
        response.end(`window.__weworkBrowserDataCacheResource = ${cacheResourceRequests}`)
        return true
      }
      if (request.method !== 'GET' || url.pathname !== FIXTURE_PATH) return false
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(fixtureHtml())
      return true
    },

    async verify(control) {
      const fixtureUrl = `${control.url}${FIXTURE_PATH}`
      const redirectUrl = `${control.url}${REDIRECT_PATH}`
      await control.command('waitFor', RIGHT_PANEL_TOGGLE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('click', RIGHT_PANEL_TOGGLE_SELECTOR)
      await control.command('click', RIGHT_BROWSER_OPTION_SELECTOR)
      await control.command('waitFor', BROWSER_INPUT_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('finishAnimations', 'body')
      const browserPanelMetrics = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-panel"]`
        )
      )
      const [browserPanelWidth, rightPanelShellWidth] = await Promise.all([
        control.command(
          'getInlineStyle',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-panel"]`,
          { value: 'width' }
        ),
        control.command(
          'getInlineStyle',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel-shell"]`,
          { value: 'width' }
        ),
      ])
      assert.equal(browserPanelMetrics.length, 1, 'Expected exactly one active browser panel')
      assert.ok(
        browserPanelMetrics[0].width > 1 && browserPanelMetrics[0].height > 1,
        `Browser panel is not visible: ${JSON.stringify({
          metrics: browserPanelMetrics[0],
          browserPanelWidth,
          rightPanelShellWidth,
        })}`
      )
      await control.command('fill', BROWSER_INPUT_SELECTOR, { value: fixtureUrl })
      await waitForControlValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureUrl,
        uiTimeoutMs,
        'Browser URL input did not receive fixture URL before submit'
      )
      await control.command('submit', BROWSER_INPUT_SELECTOR)
      const bridgeIdentity = await waitForBridgeIdentity(executorHome, uiTimeoutMs)
      const bridgeCall = payload => callBridge(bridgeIdentity, payload)
      // A bridge open adopts the pane-derived label created by the UI submit
      // (the frontend relabels the existing webview to the fixed bridge
      // label), so later bridge calls and agent-state events resolve to the
      // same logical browser.
      const openResult = await bridgeCall({
        action: 'open',
        url: fixtureUrl,
        timeoutMs: 8_000,
      })
      assert.equal(openResult.ok, true, `Bridge open failed: ${JSON.stringify(openResult)}`)
      await control.command('waitFor', BROWSER_INPUT_SELECTOR, { timeoutMs: uiTimeoutMs })
      await waitForControlValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureUrl,
        uiTimeoutMs,
        'Bridge open did not show the fixture URL in the browser panel'
      )
      await control.command('waitFor', BROWSER_NATIVE_VIEW_SELECTOR, { timeoutMs: uiTimeoutMs })
      const readyWait = await bridgeCall({
        action: 'waitFor',
        options: { condition: { textVisible: READY_TEXT } },
        timeoutMs: 5_000,
      })
      assert.equal(readyWait.ok, true, `Bridge fixture wait failed: ${JSON.stringify(readyWait)}`)
      await new Promise(resolve => setTimeout(resolve, 300))

      const pendingAgentWait = bridgeCall({
        action: 'waitFor',
        text: 'WEWORK_AGENT_STATUS_E2E_NEVER_APPEARS',
        timeoutMs: 4_000,
      })
      await control.command('waitFor', BROWSER_AGENT_STATUS_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', BROWSER_AGENT_PAUSE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('click', BROWSER_AGENT_PAUSE_SELECTOR)
      await control.command('waitFor', BROWSER_AGENT_RESUME_SELECTOR, { timeoutMs: uiTimeoutMs })
      const pausedClick = await withTimeout(
        bridgeCall({
          action: 'click',
          x: 12,
          y: 12,
          timeoutMs: 2_000,
        }),
        2_500,
        'A pending bridge wait blocked an independent browser request'
      )
      assert.equal(
        pausedClick.ok,
        false,
        `Paused click should be blocked: ${JSON.stringify(pausedClick)}`
      )
      assert.equal(pausedClick.error?.code, 'user_control')
      await control.command('click', BROWSER_AGENT_RESUME_SELECTOR)
      await pendingAgentWait

      const cookieFixtureUrl = `${control.url}${BROWSER_DATA_COOKIE_PATH}`
      await bridgeCall({ action: 'open', url: cookieFixtureUrl, timeoutMs: 8_000 })
      await bridgeCall({
        action: 'waitFor',
        options: { condition: { textVisible: 'Browser data Cookie fixture' } },
        timeoutMs: 5_000,
      })
      const cookieBeforeClear = await bridgeCall({
        action: 'evaluate',
        expression: "document.cookie.includes('wework_browser_data_e2e=present')",
        timeoutMs: 5_000,
      })
      assert.equal(
        cookieBeforeClear.ok,
        true,
        `Cookie fixture evaluation failed: ${JSON.stringify(cookieBeforeClear)}`
      )
      assert.equal(cookieBeforeClear.value, true, 'Cookie fixture did not set its test cookie')
      await control.command('click', BROWSER_MORE_BUTTON_SELECTOR)
      await control.command('click', BROWSER_CLEAR_DATA_SELECTOR)
      await control.command('click', BROWSER_CLEAR_COOKIES_SELECTOR)
      await control.command('waitFor', TRANSIENT_NOTICE_SELECTOR, {
        text: BROWSER_CLEAR_STARTED_TEXT,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', TRANSIENT_NOTICE_SELECTOR, {
        text: BROWSER_CLEAR_COMPLETED_TEXT,
        timeoutMs: uiTimeoutMs,
      })
      const cookieAfterClear = await bridgeCall({
        action: 'evaluate',
        expression: "document.cookie.includes('wework_browser_data_e2e=present')",
        timeoutMs: 5_000,
      })
      assert.equal(
        cookieAfterClear.ok,
        true,
        `Cookie clear evaluation failed: ${JSON.stringify(cookieAfterClear)}`
      )
      assert.equal(cookieAfterClear.value, false, 'Cookie clear did not remove the fixture cookie')

      const cacheFixtureUrl = `${control.url}${BROWSER_DATA_CACHE_PATH}`
      await bridgeCall({ action: 'open', url: cacheFixtureUrl, timeoutMs: 8_000 })
      await bridgeCall({
        action: 'waitFor',
        options: { condition: { textVisible: 'Browser data cache fixture' } },
        timeoutMs: 5_000,
      })
      assert.equal(cacheResourceRequests, 1, 'Cache fixture did not request its resource once')
      await control.command('click', BROWSER_MORE_BUTTON_SELECTOR)
      await control.command('click', BROWSER_CLEAR_DATA_SELECTOR)
      await control.command('click', BROWSER_CLEAR_CACHE_SELECTOR)
      await control.command('waitFor', TRANSIENT_NOTICE_SELECTOR, {
        text: BROWSER_CLEAR_COMPLETED_TEXT,
        timeoutMs: uiTimeoutMs,
      })
      await bridgeCall({ action: 'close', timeoutMs: 8_000 })
      await control.command('fill', BROWSER_INPUT_SELECTOR, { value: cacheFixtureUrl })
      await control.command('submit', BROWSER_INPUT_SELECTOR)
      await control.command('waitFor', BROWSER_NATIVE_VIEW_SELECTOR, { timeoutMs: uiTimeoutMs })
      await bridgeCall({
        action: 'waitFor',
        options: { condition: { textVisible: 'Browser data cache fixture' } },
        timeoutMs: 5_000,
      })
      assert.equal(cacheResourceRequests, 2, 'Cache clear did not force a resource request')

      await writeStaleBridgeRuntime(bridgeIdentity)
      const mcpResult = await withBrowserMcp(bridgeIdentity, async callTool => {
        const openText = await callTool('browser_open_and_inspect', {
          url: redirectUrl,
          inspectOptions: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
          timeoutMs: 8_000,
        })
        assert.ok(
          openText.includes('Combined: open_and_inspect ok=true'),
          `open_and_inspect failed:\n${openText}`
        )
        assert.ok(openText.includes(READY_TEXT))
        const inspectText = await callTool('browser_inspect', {
          inspectOptions: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
          timeoutMs: 8_000,
        })
        const inspectJson = parseToolJson(inspectText)
        const mcpInputNode = findNode(
          inspectJson,
          node => node.role === 'textbox' && node.name === 'Agent name',
          'MCP Agent name textbox'
        )
        const mcpButtonNode = findNode(
          inspectJson,
          node => node.role === 'button' && node.name === 'Run agent form',
          'MCP run button'
        )

        const fillText = await callTool('browser_fill', {
          ref: mcpInputNode.ref,
          text: 'Alpha Beta',
          timeoutMs: 8_000,
        })
        const fillJson = parseToolJson(fillText)
        assert.equal(fillJson.action, 'fill')
        assert.equal(fillJson.ok, true)
        assert.equal(fillJson.effect.valueChanged, true)

        const clickText = await callTool('browser_click', {
          ref: mcpButtonNode.ref,
          timeoutMs: 8_000,
        })
        const clickJson = parseToolJson(clickText)
        assert.equal(clickJson.action, 'click')
        assert.equal(clickJson.ok, true)
        assert.equal(clickJson.effect.domChanged, true)

        const waitText = await callTool('browser_wait_and_inspect', {
          condition: { textVisible: CLICKED_TEXT },
          inspectOptions: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
          timeoutMs: 5_000,
        })
        assert.ok(waitText.includes('Combined: wait_and_inspect ok=true'))
        assert.ok(waitText.includes(CLICKED_TEXT))

        const capabilitiesText = await callTool('browser_capabilities')
        assert.ok(capabilitiesText.includes('browser.capabilities'))
        assert.ok(capabilitiesText.includes('wkwebview'))

        const p1InspectJson = parseToolJson(waitText)
        const selectNode = findNode(
          p1InspectJson.inspect,
          node => node.role === 'combobox' && node.name === 'Agent kind',
          'MCP Agent kind select'
        )
        const checkboxNode = findNode(
          p1InspectJson.inspect,
          node => node.role === 'checkbox' && node.name.includes('Confirm'),
          'MCP confirm checkbox'
        )
        const hoverNode = findNode(
          p1InspectJson.inspect,
          node => node.role === 'button' && node.name === 'Hover target',
          'MCP hover button'
        )

        const selectText = await callTool('browser_select_option', {
          ref: selectNode.ref,
          values: ['finance'],
          timeoutMs: 5_000,
        })
        const selectJson = parseToolJson(selectText)
        assert.equal(selectJson.action, 'select')
        assert.equal(selectJson.ok, true)

        const checkedText = await callTool('browser_set_checked', {
          ref: checkboxNode.ref,
          checked: true,
          timeoutMs: 5_000,
        })
        const checkedJson = parseToolJson(checkedText)
        assert.equal(checkedJson.action, 'setChecked')
        assert.equal(checkedJson.ok, true)

        const hoverText = await callTool('browser_hover', {
          ref: hoverNode.ref,
          timeoutMs: 5_000,
        })
        const hoverJson = parseToolJson(hoverText)
        assert.equal(hoverJson.action, 'hover')
        assert.equal(hoverJson.ok, true)

        const p2Text = await callTool('browser_native_input_probe', { kind: 'click' })
        const p2Json = parseToolJson(p2Text)
        assert.equal(p2Json.kind, 'browser.nativeInputProbe')
        assert.equal(p2Json.error?.code, 'requires_trusted_input')

        return {
          openText,
          fillText,
          clickText,
          waitText,
          capabilitiesText,
          selectText,
          checkedText,
          hoverText,
          p2Text,
        }
      })

      const initialInspect = await bridgeCall({
        action: 'inspect',
        options: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
        timeoutMs: 5_000,
      })
      assert.equal(initialInspect.kind, 'browser.inspect')
      assert.ok(initialInspect.inspectText.includes(HOVER_TEXT))
      const inputNode = findNode(
        initialInspect,
        node => node.role === 'textbox' && node.name === 'Agent name',
        'Agent name textbox'
      )
      const buttonNode = findNode(
        initialInspect,
        node => node.role === 'button' && node.name === 'Run agent form',
        'Run button'
      )
      const deleteNode = findNode(
        initialInspect,
        node => node.role === 'button' && node.name === 'Delete agent record',
        'Delete button'
      )
      const fillResult = await bridgeCall({
        action: 'fill',
        ref: inputNode.ref,
        text: 'Gamma Delta',
        timeoutMs: 5_000,
      })
      assert.equal(fillResult.ok, true, `Fill failed: ${JSON.stringify(fillResult)}`)
      assert.equal(fillResult.effect.valueChanged, true)

      const afterFillInspect = await bridgeCall({
        action: 'inspect',
        options: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
        timeoutMs: 5_000,
      })
      assert.ok(afterFillInspect.inspectText.includes(DIRECT_FILLED_TEXT))

      const clickResult = await bridgeCall({
        action: 'click',
        ref: buttonNode.ref,
        timeoutMs: 5_000,
      })
      assert.equal(clickResult.ok, true, `Click failed: ${JSON.stringify(clickResult)}`)
      assert.equal(clickResult.effect.domChanged, true)

      const finalInspect = await bridgeCall({
        action: 'inspect',
        options: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
        timeoutMs: 5_000,
      })
      assert.ok(finalInspect.inspectText.includes(DIRECT_CLICKED_TEXT))

      const deleteApproval = await bridgeCall({
        action: 'click',
        ref: deleteNode.ref,
        timeoutMs: 5_000,
      })
      assert.equal(
        deleteApproval.ok,
        false,
        `Delete click should require approval: ${JSON.stringify(deleteApproval)}`
      )
      assert.equal(deleteApproval.error?.code, 'approval_required')
      assert.ok(deleteApproval.approval?.approvalId)
      await control.command('waitFor', BROWSER_AGENT_APPROVE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('click', BROWSER_AGENT_APPROVE_SELECTOR)

      const approvedDeleteResult = await bridgeCall({
        action: 'click',
        ref: deleteNode.ref,
        timeoutMs: 5_000,
      })
      assert.equal(
        approvedDeleteResult.ok,
        true,
        `Approved delete click failed: ${JSON.stringify(approvedDeleteResult)}`
      )

      const afterDeleteInspect = await bridgeCall({
        action: 'inspect',
        options: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
        timeoutMs: 5_000,
      })
      assert.ok(afterDeleteInspect.inspectText.includes(DIRECT_DELETED_TEXT))
      const currentScrollBoxNode = findNode(
        afterDeleteInspect,
        node => node.role === 'region' && node.name === 'Scrollable results',
        'Current scrollable results region'
      )

      const waitResult = await bridgeCall({
        action: 'waitFor',
        options: { condition: { waitUntil: 'pageStable' }, quietMs: 100 },
        timeoutMs: 5_000,
      })
      assert.equal(waitResult.kind, 'browser.wait')
      assert.equal(waitResult.ok, true)

      const scrollResult = await bridgeCall({
        action: 'scroll',
        ref: currentScrollBoxNode.ref,
        options: { direction: 'down', amount: 500 },
        timeoutMs: 5_000,
      })
      assert.equal(scrollResult.ok, true, `Scroll failed: ${JSON.stringify(scrollResult)}`)

      const afterScrollInspect = await bridgeCall({
        action: 'inspect',
        options: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
        timeoutMs: 5_000,
      })
      findReadonlyNode(afterScrollInspect, node => node.name === SCROLLED_TEXT, 'Scroll marker')

      const screenshotResult = await bridgeCall({
        action: 'screenshot',
      })
      assert.equal(screenshotResult.kind, 'browser.screenshot')
      assert.equal(screenshotResult.format, 'png')
      assert.ok(screenshotResult.screenshotId)
      assert.ok(screenshotResult.path.endsWith('.png'))

      const capabilities = await bridgeCall({
        action: 'capabilities',
      })
      assert.equal(capabilities.kind, 'browser.capabilities')
      assert.equal(capabilities.actions.trustedNativeInput, 'poc_only')

      // file:// local file support: the bridge renders a local HTML page, and
      // an un-previewable local file surfaces a notice instead of downloading.
      const localHtmlPath = join(resultDir, 'local-file-fixture.html')
      await writeFile(localHtmlPath, localFixtureHtml(), 'utf8')
      const localOpenResult = await bridgeCall({
        action: 'open',
        url: pathToFileURL(localHtmlPath).href,
        timeoutMs: 8_000,
      })
      assert.equal(
        localOpenResult.ok,
        true,
        `Bridge file:// open failed: ${JSON.stringify(localOpenResult)}`
      )
      const localFileWaitResult = await bridgeCall({
        action: 'waitFor',
        options: { condition: { textVisible: LOCAL_FILE_TEXT } },
        timeoutMs: 5_000,
      })
      assert.equal(localFileWaitResult.kind, 'browser.wait')
      assert.equal(localFileWaitResult.ok, true)
      const localFileInspect = await bridgeCall({
        action: 'inspect',
        options: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 40 },
        timeoutMs: 5_000,
      })
      assert.ok(
        localFileInspect.inspectText.includes(LOCAL_FILE_TEXT),
        `file:// page was not rendered: ${localFileInspect.inspectText}`
      )

      const localMarkdownPath = join(resultDir, 'local-markdown-fixture.md')
      await writeFile(localMarkdownPath, `# ${LOCAL_MARKDOWN_TEXT}\n`, 'utf8')
      const localMarkdownOpenResult = await bridgeCall({
        action: 'open',
        url: pathToFileURL(localMarkdownPath).href,
        timeoutMs: 8_000,
      })
      assert.equal(
        localMarkdownOpenResult.ok,
        true,
        `Bridge file:// markdown open failed: ${JSON.stringify(localMarkdownOpenResult)}`
      )
      const localMarkdownWaitResult = await bridgeCall({
        action: 'waitFor',
        options: { condition: { textVisible: LOCAL_MARKDOWN_TEXT } },
        timeoutMs: 5_000,
      })
      assert.equal(localMarkdownWaitResult.kind, 'browser.wait')
      assert.equal(localMarkdownWaitResult.ok, true)
      const localMarkdownInspect = await bridgeCall({
        action: 'inspect',
        options: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 40 },
        timeoutMs: 5_000,
      })
      assert.ok(
        localMarkdownInspect.inspectText.includes(LOCAL_MARKDOWN_TEXT),
        `markdown file was not rendered: ${localMarkdownInspect.inspectText}`
      )

      const localPlainTextPath = join(resultDir, 'local-plain-text-fixture')
      await writeFile(localPlainTextPath, `${LOCAL_PLAINTEXT_TEXT}\n第二行`, 'utf8')
      const localPlainTextOpenResult = await bridgeCall({
        action: 'open',
        url: pathToFileURL(localPlainTextPath).href,
        timeoutMs: 8_000,
      })
      assert.equal(
        localPlainTextOpenResult.ok,
        true,
        `Bridge file:// plain text open failed: ${JSON.stringify(localPlainTextOpenResult)}`
      )
      const localPlainTextWaitResult = await bridgeCall({
        action: 'waitFor',
        options: { condition: { textVisible: LOCAL_PLAINTEXT_TEXT } },
        timeoutMs: 5_000,
      })
      assert.equal(localPlainTextWaitResult.kind, 'browser.wait')
      assert.equal(localPlainTextWaitResult.ok, true)
      const localPlainTextInspect = await bridgeCall({
        action: 'inspect',
        options: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 40 },
        timeoutMs: 5_000,
      })
      assert.ok(
        localPlainTextInspect.inspectText.includes(LOCAL_PLAINTEXT_TEXT),
        `plain text file was not rendered: ${localPlainTextInspect.inspectText}`
      )

      const localDirectoryPath = join(resultDir, 'local-directory-fixture')
      await mkdir(join(localDirectoryPath, 'nested'), { recursive: true })
      await writeFile(join(localDirectoryPath, LOCAL_DIRECTORY_TEXT), 'directory fixture', 'utf8')
      const localDirectoryOpenResult = await bridgeCall({
        action: 'open',
        url: pathToFileURL(localDirectoryPath).href,
        timeoutMs: 8_000,
      })
      assert.equal(
        localDirectoryOpenResult.ok,
        true,
        `Bridge file:// directory open failed: ${JSON.stringify(localDirectoryOpenResult)}`
      )
      const localDirectoryWaitResult = await bridgeCall({
        action: 'waitFor',
        options: { condition: { textVisible: LOCAL_DIRECTORY_TEXT } },
        timeoutMs: 5_000,
      })
      assert.equal(localDirectoryWaitResult.kind, 'browser.wait')
      assert.equal(localDirectoryWaitResult.ok, true)
      const localDirectoryInspect = await bridgeCall({
        action: 'inspect',
        options: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
        timeoutMs: 5_000,
      })
      assert.ok(
        localDirectoryInspect.inspectText.includes('Index of') &&
          localDirectoryInspect.inspectText.includes('nested/') &&
          localDirectoryInspect.inspectText.includes(LOCAL_DIRECTORY_TEXT),
        `file:// directory was not rendered: ${localDirectoryInspect.inspectText}`
      )

      const localZipPath = join(resultDir, 'local-file-fixture.zip')
      const zipBytes = Buffer.alloc(1024)
      zipBytes.set([0x50, 0x4b, 0x03, 0x04])
      await writeFile(localZipPath, zipBytes)
      const localZipUrl = pathToFileURL(localZipPath).href
      await control.command('fill', BROWSER_INPUT_SELECTOR, { value: localZipUrl })
      await waitForControlValue(
        control,
        BROWSER_INPUT_SELECTOR,
        localZipUrl,
        uiTimeoutMs,
        'Browser URL input did not receive local zip URL before submit'
      )
      await control.command('submit', BROWSER_INPUT_SELECTOR)
      await control.command('waitFor', TRANSIENT_NOTICE_SELECTOR, {
        text: LOCAL_TOAST_TEXT,
        timeoutMs: uiTimeoutMs,
      })

      await writeFile(
        join(resultDir, 'embedded-browser-agent-result.json'),
        `${JSON.stringify(
          {
            bridgeUrl: bridgeIdentity.baseUrl,
            mcpResult,
            initialInspectId: initialInspect.inspectId,
            inputRef: inputNode.ref,
            buttonRef: buttonNode.ref,
            deleteRef: deleteNode.ref,
            fillEffect: fillResult.effect,
            clickEffect: clickResult.effect,
            approvalId: deleteApproval.approval.approvalId,
            deleteEffect: approvedDeleteResult.effect,
            waitReason: waitResult.reason,
            screenshot: screenshotResult,
            capabilities: capabilities.p2,
            localFileInspectId: localFileInspect.inspectId,
            localFileUrl: pathToFileURL(localHtmlPath).href,
            finalText: afterDeleteInspect.inspectText,
          },
          null,
          2
        )}\n`,
        'utf8'
      )
    },
  }
}
