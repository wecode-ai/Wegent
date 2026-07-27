import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const RIGHT_PANEL_TOGGLE_SELECTOR = '[data-testid="toggle-right-workspace-panel-button"]'
const RIGHT_BROWSER_OPTION_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-browser-option"]`
const BROWSER_INPUT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-url-input"]`
const BROWSER_AGENT_STATUS_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-agent-status"]`
const BROWSER_AGENT_PAUSE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-agent-pause-button"]`
const BROWSER_AGENT_RESUME_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-agent-resume-button"]`
const BROWSER_AGENT_APPROVE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-agent-approval-approve-button"]`
const BROWSER_LABEL = 'workspace-browser'
const FIXTURE_PATH = '/embedded-browser-agent-fixture'
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
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(scriptDir, '..', '..', '..', '..')

function fixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${READY_TEXT}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 32px; }
      label, input, button, output, select { display: block; margin-block: 12px; }
      input, button, select { font: inherit; padding: 8px 10px; }
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
    <label><input id="agent-confirm" type="checkbox" /> Confirm</label>
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

async function waitForBridgeUrl(resultDir, timeoutMs) {
  const logPath = join(resultDir, 'app.log')
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const entries = await readdir(resultDir).catch(() => [])
    const logPaths = [
      logPath,
      ...entries
        .filter(name => /^wework-tauri-.*\.log$/.test(name))
        .map(name => join(resultDir, name)),
    ]
    const contents = await Promise.all(logPaths.map(path => readFile(path, 'utf8').catch(() => '')))
    const content = contents.join('\n')
    const match = content.match(/Embedded browser bridge listening on ([^\s]+)/)
    if (match) return `http://${match[1]}`
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for embedded browser bridge address in app.log')
}

async function callBridge(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

async function withBrowserMcp(bridgeUrl, callback) {
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
      WEWORK_EMBEDDED_BROWSER_BRIDGE_URL: bridgeUrl,
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

export function createDesktopScenario({ resultDir, uiTimeoutMs }) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'GET' || url.pathname !== FIXTURE_PATH) return false
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(fixtureHtml())
      return true
    },

    async verify(control) {
      const fixtureUrl = `${control.url}${FIXTURE_PATH}`
      await control.command('waitFor', RIGHT_PANEL_TOGGLE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('click', RIGHT_PANEL_TOGGLE_SELECTOR)
      await control.command('click', RIGHT_BROWSER_OPTION_SELECTOR)
      await control.command('waitFor', BROWSER_INPUT_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', BROWSER_INPUT_SELECTOR, { value: fixtureUrl })
      await waitForControlValue(
        control,
        BROWSER_INPUT_SELECTOR,
        fixtureUrl,
        uiTimeoutMs,
        'Browser URL input did not receive fixture URL before submit'
      )
      await control.command('press', BROWSER_INPUT_SELECTOR, { key: 'Enter' })
      const bridgeUrl = await waitForBridgeUrl(resultDir, uiTimeoutMs)
      const openResult = await callBridge(bridgeUrl, {
        action: 'open',
        url: fixtureUrl,
        timeoutMs: 8_000,
      })
      assert.equal(openResult.ok, true, `Bridge open failed: ${JSON.stringify(openResult)}`)

      const pendingAgentWait = callBridge(bridgeUrl, {
        action: 'waitFor',
        text: 'WEWORK_AGENT_STATUS_E2E_NEVER_APPEARS',
        timeoutMs: 4_000,
      })
      await control.command('waitFor', BROWSER_AGENT_STATUS_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', BROWSER_AGENT_PAUSE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('click', BROWSER_AGENT_PAUSE_SELECTOR)
      await control.command('waitFor', BROWSER_AGENT_RESUME_SELECTOR, { timeoutMs: uiTimeoutMs })
      const pausedClick = await callBridge(bridgeUrl, {
        action: 'click',
        x: 12,
        y: 12,
        timeoutMs: 2_000,
      })
      assert.equal(
        pausedClick.ok,
        false,
        `Paused click should be blocked: ${JSON.stringify(pausedClick)}`
      )
      assert.equal(pausedClick.error?.code, 'user_control')
      await control.command('click', BROWSER_AGENT_RESUME_SELECTOR)
      await pendingAgentWait

      const mcpResult = await withBrowserMcp(bridgeUrl, async callTool => {
        const openText = await callTool('browser_open_and_inspect', {
          url: fixtureUrl,
          inspectOptions: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
          timeoutMs: 8_000,
        })
        assert.ok(
          openText.includes('Combined: open_and_inspect ok=true'),
          `open_and_inspect failed:\n${openText}`
        )
        assert.ok(openText.includes(READY_TEXT))
        const openJson = parseToolJson(openText)
        const mcpInputNode = findNode(
          openJson.inspect,
          node => node.role === 'textbox' && node.name === 'Agent name',
          'MCP Agent name textbox'
        )
        const mcpButtonNode = findNode(
          openJson.inspect,
          node => node.role === 'button' && node.name === 'Run agent form',
          'MCP run button'
        )

        const fillText = await callTool('browser_fill', {
          ref: mcpInputNode.ref,
          text: 'Alpha Beta',
          timeoutMs: 8_000,
        })
        assert.ok(fillText.includes('{"action":"fill","success":true}'))
        assert.ok(fillText.includes('"valueChanged": true'))

        const clickText = await callTool('browser_click', {
          ref: mcpButtonNode.ref,
          timeoutMs: 8_000,
        })
        assert.ok(clickText.includes('{"action":"click","success":true}'))

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

      const initialInspect = await callBridge(bridgeUrl, {
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
      const fillResult = await callBridge(bridgeUrl, {
        action: 'fill',
        ref: inputNode.ref,
        text: 'Gamma Delta',
        timeoutMs: 5_000,
      })
      assert.equal(fillResult.ok, true, `Fill failed: ${JSON.stringify(fillResult)}`)
      assert.equal(fillResult.effect.valueChanged, true)

      const afterFillInspect = await callBridge(bridgeUrl, {
        action: 'inspect',
        options: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
        timeoutMs: 5_000,
      })
      assert.ok(afterFillInspect.inspectText.includes(DIRECT_FILLED_TEXT))

      const clickResult = await callBridge(bridgeUrl, {
        action: 'click',
        ref: buttonNode.ref,
        timeoutMs: 5_000,
      })
      assert.equal(clickResult.ok, true, `Click failed: ${JSON.stringify(clickResult)}`)
      assert.equal(clickResult.effect.domChanged, true)

      const finalInspect = await callBridge(bridgeUrl, {
        action: 'inspect',
        options: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
        timeoutMs: 5_000,
      })
      assert.ok(finalInspect.inspectText.includes(DIRECT_CLICKED_TEXT))

      const deleteApproval = await callBridge(bridgeUrl, {
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

      const approvedDeleteResult = await callBridge(bridgeUrl, {
        action: 'click',
        ref: deleteNode.ref,
        timeoutMs: 5_000,
      })
      assert.equal(
        approvedDeleteResult.ok,
        true,
        `Approved delete click failed: ${JSON.stringify(approvedDeleteResult)}`
      )

      const afterDeleteInspect = await callBridge(bridgeUrl, {
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

      const waitResult = await callBridge(bridgeUrl, {
        action: 'waitFor',
        options: { condition: { waitUntil: 'pageStable' }, quietMs: 100 },
        timeoutMs: 5_000,
      })
      assert.equal(waitResult.kind, 'browser.wait')
      assert.equal(waitResult.ok, true)

      const scrollResult = await callBridge(bridgeUrl, {
        action: 'scroll',
        ref: currentScrollBoxNode.ref,
        options: { direction: 'down', amount: 500 },
        timeoutMs: 5_000,
      })
      assert.equal(scrollResult.ok, true, `Scroll failed: ${JSON.stringify(scrollResult)}`)

      const afterScrollInspect = await callBridge(bridgeUrl, {
        action: 'inspect',
        options: { interactiveOnly: false, includeTextBlocks: true, maxNodes: 80 },
        timeoutMs: 5_000,
      })
      findReadonlyNode(afterScrollInspect, node => node.name === SCROLLED_TEXT, 'Scroll marker')

      const screenshotResult = await callBridge(bridgeUrl, {
        action: 'screenshot',
      })
      assert.equal(screenshotResult.kind, 'browser.screenshot')
      assert.equal(screenshotResult.format, 'png')
      assert.ok(screenshotResult.screenshotId)
      assert.ok(screenshotResult.path.endsWith('.png'))

      const capabilities = await callBridge(bridgeUrl, {
        action: 'capabilities',
      })
      assert.equal(capabilities.kind, 'browser.capabilities')
      assert.equal(capabilities.actions.trustedNativeInput, 'poc_only')

      await writeFile(
        join(resultDir, 'embedded-browser-agent-result.json'),
        `${JSON.stringify(
          {
            bridgeUrl,
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
