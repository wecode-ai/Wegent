import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const CENTRAL_HARNESS_SELECTOR = '[data-testid="central-harness-terminal"]'
const OPEN_CODE_ARGS_FILE = '.wework-opencode-e2e-args'
const OPEN_CODE_PROXY_FILE = '.wework-opencode-e2e-proxy'
const CLAUDE_CODE_ARGS_FILE = '.wework-claude-code-e2e-args'
const CLAUDE_CODE_ENV_FILE = '.wework-claude-code-e2e-env'
const CLAUDE_CODE_PROXY_FILE = '.wework-claude-code-e2e-proxy'

async function createHarnessFixture({
  executablePath,
  name,
  version,
  argsFile,
  envFile = null,
  proxyFile,
  proxyVariable,
}) {
  await mkdir(dirname(executablePath), { recursive: true })
  await writeFile(
    executablePath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '${version}\\n'
  exit 0
fi
args_file="$HOME/${argsFile}"
: > "$args_file"
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$args_file"
done
${envFile ? `printf '%s\\n' "$WEWORK_HARNESS_E2E" > "$HOME/${envFile}"` : ''}
printf '%s\\n' "$${proxyVariable}" > "$HOME/${proxyFile}"
printf '\\033[2J\\033[H${name} E2E harness\\r\\n'
exec sleep 600
`
  )
  await chmod(executablePath, 0o755)
}

async function createHarnessFixtures(homePath) {
  const openCodeExecutable = join(homePath, '.wework-e2e-bin', 'opencode')
  const claudeCodeExecutable = join(homePath, '.wework-e2e-bin', 'claude')
  await Promise.all([
    createHarnessFixture({
      executablePath: openCodeExecutable,
      name: 'OpenCode',
      version: 'opencode-e2e 1.0.0',
      argsFile: OPEN_CODE_ARGS_FILE,
      proxyFile: OPEN_CODE_PROXY_FILE,
      proxyVariable: 'OPENCODE_CONFIG_CONTENT',
    }),
    createHarnessFixture({
      executablePath: claudeCodeExecutable,
      name: 'Claude Code',
      version: 'claude-code-e2e 2.0.0',
      argsFile: CLAUDE_CODE_ARGS_FILE,
      envFile: CLAUDE_CODE_ENV_FILE,
      proxyFile: CLAUDE_CODE_PROXY_FILE,
      proxyVariable: 'ANTHROPIC_BASE_URL',
    }),
  ])
  return { openCodeExecutable, claudeCodeExecutable }
}

async function waitForFile(path, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastValue = null
  while (Date.now() < deadline) {
    try {
      lastValue = await readFile(path, 'utf8')
      if (lastValue === expected) return
    } catch {
      // The harness writes the evidence file immediately after launch.
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(lastValue, expected, `Unexpected harness evidence in ${path}`)
}

async function readFileWhenReady(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = await readFile(path, 'utf8')
      if (value.trim()) return value.trim()
    } catch {
      // The harness writes the evidence file immediately after launch.
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`Timed out waiting for harness evidence in ${path}`)
}

async function probeMessagesProxy(url, prompt) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'wework-local-router',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'wework-selected',
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const body = await response.text()
  assert.equal(response.status, 200, `Messages proxy returned ${response.status}: ${body}`)
  assert.match(body, /event: message_start/, 'Messages proxy did not emit message_start')
  assert.match(body, /event: message_stop/, 'Messages proxy did not emit message_stop')
}

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeSse(response, events) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  })
  response.end(events.join(''))
}

async function createLocalProject(control, workspacePath, timeoutMs) {
  await control.command('waitFor', '[data-testid="project-work-button"]', { timeoutMs })
  await control.command('click', '[data-testid="project-work-button"]')
  await control.command('click', '[data-testid="add-local-project-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', { timeoutMs })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', { timeoutMs })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: 'local-terminal-e2e',
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'local-terminal-e2e',
    timeoutMs,
  })
}

async function configureHarnesses(control, executables, timeoutMs, capturePage) {
  await control.command('click', '[data-testid="settings-button"]')
  await control.command('click', '[data-testid="settings-menu-button"]')
  const settingsSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (!settingsSnapshot.testIds.includes('settings-nav-harnesses')) {
    await control.command('click', '[data-testid="general-experimental-features-toggle"]')
    await control.command('waitFor', '[data-testid="settings-nav-harnesses"]', { timeoutMs })
  }
  await control.command('click', '[data-testid="settings-nav-harnesses"]')
  await control.command('waitFor', '[data-testid="harness-settings-page"]', { timeoutMs })
  await capturePage(control, 'local-harness-01-settings-open.png')
  await control.command('fill', '[data-testid="harness-executable-opencode"]', {
    value: executables.openCodeExecutable,
  })
  await control.command('fill', '[data-testid="harness-executable-claude_code"]', {
    value: executables.claudeCodeExecutable,
  })
  await control.command('select', '[data-testid="harness-permission-mode-claude_code"]', {
    value: 'plan',
  })
  await control.command('fill', '[data-testid="harness-args-claude_code"]', {
    value: '--verbose',
  })
  await control.command('fill', '[data-testid="harness-env-claude_code"]', {
    value: 'WEWORK_HARNESS_E2E=claude-settings',
  })
  await control.command('clickWhenEnabled', '[data-testid="save-harness-settings"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="harness-settings-opencode"]', {
    text: 'opencode-e2e 1.0.0',
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="harness-settings-claude_code"]', {
    text: 'claude-code-e2e 2.0.0',
    timeoutMs,
  })
  await capturePage(control, 'local-harness-02-settings-detected.png')
  await control.command('scrollIntoView', '[data-testid="harness-permission-mode-claude_code"]')
  await capturePage(control, 'local-harness-03-claude-settings.png')
  await control.command('click', '[data-testid="settings-back-button"]')
  await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]', { timeoutMs })
}

async function startHarness({
  control,
  harnessId,
  model,
  prompt,
  timeoutMs,
  capturePage,
  runtimeMenuScreenshot,
  modelMenuScreenshot,
  readyScreenshot,
}) {
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-harness-selector"]`
  )
  await control.command('waitFor', `[data-testid="workbench-harness-option-${harnessId}"]`, {
    visible: true,
    timeoutMs,
  })
  await capturePage(control, runtimeMenuScreenshot)
  await control.command(
    'clickWhenEnabled',
    `[data-testid="workbench-harness-option-${harnessId}"]`,
    { timeoutMs }
  )
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-harness-model-selector"]`
  )
  await control.command(
    'waitFor',
    `[data-testid^="workbench-harness-model-option-${harnessId}-"]`,
    {
      visible: true,
      text: model,
      timeoutMs,
    }
  )
  await capturePage(control, modelMenuScreenshot)
  await control.command(
    'clickDescendantInElementWithText',
    `[data-testid^="workbench-harness-model-option-${harnessId}-"]`,
    {
      text: model,
      target: 'span',
      timeoutMs,
    }
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-harness-model-selector"]`,
    {
      text: model,
      timeoutMs,
    }
  )
  await control.command('fill', '[data-testid="chat-message-input"]', { value: prompt })
  await capturePage(control, readyScreenshot)
  await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', { timeoutMs })
  await control.command('waitFor', CENTRAL_HARNESS_SELECTOR, { timeoutMs })
}

async function verifyHarnessWorkbenchChrome({
  control,
  title,
  timeoutMs,
  captureWorkbench,
  screenshot,
}) {
  const titleSelector = '[data-testid="workbench-pane-task-title"]'
  const rightPanelToggleSelector = '[data-testid="toggle-right-workspace-panel-button"]'
  const rightPanelSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel"]`
  const rightPanelLauncherSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-launcher"]`
  const bottomPanelToggleSelector = '[data-testid="toggle-bottom-workspace-panel-button"]'
  const bottomPanelSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="bottom-workspace-panel"]`

  await control.command('waitFor', titleSelector, {
    text: title,
    timeoutMs,
  })
  await control.command('waitFor', rightPanelToggleSelector, {
    timeoutMs,
  })
  await control.command('waitFor', bottomPanelToggleSelector, {
    timeoutMs,
  })

  await control.command('click', rightPanelToggleSelector)
  await control.command('waitFor', rightPanelLauncherSelector, { timeoutMs })
  const rightPanelSnapshot = JSON.parse(await control.command('snapshot', rightPanelSelector))
  assert.ok(
    !rightPanelSnapshot.testIds.includes('right-workspace-chat-option'),
    `${title} exposed the Codex-only side chat action`
  )
  assert.ok(
    !rightPanelSnapshot.testIds.includes('right-workspace-chat-panel'),
    `${title} exposed a Codex-only side chat`
  )

  await control.command('click', bottomPanelToggleSelector)
  await control.command('waitFor', bottomPanelSelector, {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="workspace-terminal-window"]', {
    timeoutMs,
  })
  assert.equal(
    await control.command('getAttribute', bottomPanelSelector, {
      value: 'aria-hidden',
    }),
    'false',
    `${title} did not open the bottom workspace panel`
  )
  const bottomPanelClass = await control.command('getAttribute', bottomPanelSelector, {
    value: 'class',
  })
  const bottomPanelInlineStyle = await control.command('getAttribute', bottomPanelSelector, {
    value: 'style',
  })
  assert.match(
    bottomPanelClass,
    /(?:^|\s)opacity-100(?:\s|$)/,
    `${title} did not apply the open bottom-panel style`
  )
  assert.match(
    bottomPanelInlineStyle,
    /height:\s*(?!0(?:px)?[;"\s])\d+(?:\.\d+)?px/,
    `${title} did not assign an open bottom-panel height`
  )
  const [bottomPanelMetrics] = JSON.parse(
    await control.command('getElementMetrics', bottomPanelSelector)
  )
  assert.ok(bottomPanelMetrics.width > 0, `${title} opened a zero-width bottom workspace panel`)
  assert.ok(
    bottomPanelMetrics.scrollHeight > 0,
    `${title} opened a bottom workspace panel without content`
  )
  await captureWorkbench(control, screenshot)

  await control.command('click', bottomPanelToggleSelector)
  await control.command('click', rightPanelToggleSelector)
}

export async function createDesktopScenario({
  captureScreenshot,
  homePath,
  uiTimeoutMs,
  workspacePath,
}) {
  const executables = await createHarnessFixtures(homePath)
  const harnessModelRequests = []
  const capturePage = (control, name) => captureScreenshot(control, name, 'body')
  const captureWorkbench = (control, name) =>
    captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)

  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST') return false
      if (!['/v1/chat/completions', '/v1/responses'].includes(url.pathname)) return false

      const body = await readJsonBody(request)
      const expected =
        body.model === 'kimi-k3'
          ? { path: '/v1/chat/completions', protocol: 'chat' }
          : body.model === 'deepseek-v4-pro'
            ? { path: '/v1/responses', protocol: 'responses' }
            : null
      assert.ok(expected, `Unexpected harness upstream model: ${body.model}`)
      assert.equal(url.pathname, expected.path, `${body.model} reached the wrong protocol endpoint`)
      assert.equal(body.stream, true, `${body.model} was not streamed`)
      assert.equal(
        request.headers.authorization,
        'Bearer wework-e2e-test-key',
        `${body.model} did not receive the configured authentication`
      )
      harnessModelRequests.push({ model: body.model, protocol: expected.protocol })

      if (expected.protocol === 'chat') {
        writeSse(response, [
          `data: ${JSON.stringify({
            id: 'harness-chat',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: 'harness-chat',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
          'data: [DONE]\n\n',
        ])
        return true
      }

      writeSse(response, [
        `event: response.created\ndata: ${JSON.stringify({
          type: 'response.created',
          response: {
            id: 'harness-responses',
            object: 'response',
            status: 'in_progress',
            output: [],
          },
        })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'harness-responses',
            object: 'response',
            status: 'completed',
            output: [],
            usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
          },
        })}\n\n`,
      ])
      return true
    },

    async verify(control) {
      await createLocalProject(control, workspacePath, uiTimeoutMs)
      await configureHarnesses(control, executables, uiTimeoutMs, capturePage)
      await startHarness({
        control,
        harnessId: 'opencode',
        model: 'Desktop E2E Vision',
        prompt: 'Inspect the current project',
        timeoutMs: uiTimeoutMs,
        capturePage,
        runtimeMenuScreenshot: 'local-harness-04-opencode-runtime-menu.png',
        modelMenuScreenshot: 'local-harness-05-opencode-model-menu.png',
        readyScreenshot: 'local-harness-06-opencode-ready.png',
      })
      await control.command(
        'waitFor',
        '[data-testid^="local-harness-session-row-local-terminal-"]',
        { timeoutMs: uiTimeoutMs }
      )
      await captureWorkbench(control, 'local-harness-07-opencode-running.png')

      const harnessSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        harnessSnapshot.testIds.includes('central-harness-terminal'),
        'OpenCode did not replace the central message area'
      )
      assert.ok(
        !harnessSnapshot.testIds.includes('desktop-empty-composer-frame'),
        'The empty message area remained visible behind OpenCode'
      )
      await verifyHarnessWorkbenchChrome({
        control,
        title: 'Inspect the current project',
        timeoutMs: uiTimeoutMs,
        captureWorkbench: capturePage,
        screenshot: 'local-harness-08-opencode-workbench-panels.png',
      })
      await waitForFile(
        join(homePath, OPEN_CODE_ARGS_FILE),
        '--model\nwework-messages/wework-selected\n--prompt\nInspect the current project\n',
        uiTimeoutMs
      )
      const openCodeConfig = JSON.parse(
        await readFileWhenReady(join(homePath, OPEN_CODE_PROXY_FILE), uiTimeoutMs)
      )
      const openCodeBaseUrl = openCodeConfig.provider?.['wework-messages']?.options?.baseURL
      assert.equal(typeof openCodeBaseUrl, 'string', 'OpenCode did not receive its Messages URL')
      await probeMessagesProxy(`${openCodeBaseUrl}/messages`, 'WEWORK_HARNESS_OPENCODE_CHAT_PROXY')

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid^="local-harness-session-row-local-terminal-"]')
      await control.command('waitFor', CENTRAL_HARNESS_SELECTOR, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await captureWorkbench(control, 'local-harness-09-opencode-restored.png')
      await control.command('click', '[data-testid="central-harness-close-button"]')
      await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]', {
        timeoutMs: uiTimeoutMs,
      })
      await startHarness({
        control,
        harnessId: 'claude_code',
        model: 'Desktop E2E DeepSeek Pro Vision Main',
        prompt: 'Review the current project',
        timeoutMs: uiTimeoutMs,
        capturePage,
        runtimeMenuScreenshot: 'local-harness-10-claude-code-runtime-menu.png',
        modelMenuScreenshot: 'local-harness-11-claude-code-model-menu.png',
        readyScreenshot: 'local-harness-12-claude-code-ready.png',
      })
      await captureWorkbench(control, 'local-harness-13-claude-code-running.png')
      await verifyHarnessWorkbenchChrome({
        control,
        title: 'Review the current project',
        timeoutMs: uiTimeoutMs,
        captureWorkbench: capturePage,
        screenshot: 'local-harness-14-claude-code-workbench-panels.png',
      })
      await waitForFile(
        join(homePath, CLAUDE_CODE_ARGS_FILE),
        '--permission-mode\nplan\n--verbose\n--model\nwework-selected\nReview the current project\n',
        uiTimeoutMs
      )
      await waitForFile(join(homePath, CLAUDE_CODE_ENV_FILE), 'claude-settings\n', uiTimeoutMs)
      const claudeCodeBaseUrl = await readFileWhenReady(
        join(homePath, CLAUDE_CODE_PROXY_FILE),
        uiTimeoutMs
      )
      await probeMessagesProxy(
        `${claudeCodeBaseUrl}/v1/messages`,
        'WEWORK_HARNESS_CLAUDE_RESPONSES_PROXY'
      )
      assert.deepEqual(harnessModelRequests, [
        { model: 'kimi-k3', protocol: 'chat' },
        { model: 'deepseek-v4-pro', protocol: 'responses' },
      ])

      await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
      await control.command('waitFor', '[data-testid="right-workspace-launcher"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-add-harness-opencode-option"]')
      await waitForFile(
        join(homePath, OPEN_CODE_ARGS_FILE),
        '--model\nwework-messages/wework-selected\n',
        uiTimeoutMs
      )
      await control.command('waitFor', '[data-testid="workbench-pane-task-title"]', {
        text: 'OpenCode',
        timeoutMs: uiTimeoutMs,
      })
      const multiSessionSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        multiSessionSnapshot.testIds.filter(testId =>
          testId.startsWith('local-harness-session-row-local-terminal-')
        ).length >= 2,
        'The workspace did not retain multiple harness sessions'
      )
      await captureWorkbench(control, 'local-harness-15-multiple-sessions.png')
      await control.command('click', '[data-testid="central-harness-close-button"]')
      await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]', {
        timeoutMs: uiTimeoutMs,
      })
      await captureWorkbench(control, 'local-harness-16-session-closed.png')
    },

    diagnostics() {
      return {
        openCodeArgsFile: join(homePath, OPEN_CODE_ARGS_FILE),
        openCodeProxyFile: join(homePath, OPEN_CODE_PROXY_FILE),
        claudeCodeArgsFile: join(homePath, CLAUDE_CODE_ARGS_FILE),
        claudeCodeEnvFile: join(homePath, CLAUDE_CODE_ENV_FILE),
        claudeCodeProxyFile: join(homePath, CLAUDE_CODE_PROXY_FILE),
      }
    },
  }
}
