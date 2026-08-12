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
const CLAUDE_CODE_PROXY_RESULT_FILE = '.wework-claude-code-e2e-proxy-result'
const KIMI_CODE_ARGS_FILE = '.wework-kimi-code-e2e-args'
const KIMI_CODE_ENV_FILE = '.wework-kimi-code-e2e-env'
const KIMI_CODE_INPUT_FILE = '.wework-kimi-code-e2e-input'

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
  const kimiCodeExecutable = join(homePath, '.wework-e2e-bin', 'kimi')
  await Promise.all([
    createHarnessFixture({
      executablePath: openCodeExecutable,
      name: 'OpenCode',
      version: 'opencode-e2e 1.0.0',
      argsFile: OPEN_CODE_ARGS_FILE,
      proxyFile: OPEN_CODE_PROXY_FILE,
      proxyVariable: 'OPENCODE_CONFIG_CONTENT',
    }),
    (async () => {
      await mkdir(dirname(claudeCodeExecutable), { recursive: true })
      await writeFile(
        claudeCodeExecutable,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'claude-code-e2e 2.0.0\\n'
  exit 0
fi
args_file="$HOME/${CLAUDE_CODE_ARGS_FILE}"
printf 'CALL\\n' >> "$args_file"
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$args_file"
done
printf '%s\\n' "$WEWORK_HARNESS_E2E" > "$HOME/${CLAUDE_CODE_ENV_FILE}"
printf '%s\\n' "$ANTHROPIC_BASE_URL" > "$HOME/${CLAUDE_CODE_PROXY_FILE}"
case " $* " in
  *" --output-format stream-json "*)
    case "$ANTHROPIC_BASE_URL" in
      *"/harness-router/"*)
        proxy_result_file="$HOME/${CLAUDE_CODE_PROXY_RESULT_FILE}"
        proxy_body_file="$proxy_result_file.body"
        proxy_status="$(curl -sS -o "$proxy_body_file" -w '%{http_code}' \
          -X POST "$ANTHROPIC_BASE_URL/v1/messages" \
          -H 'content-type: application/json' \
          -H 'x-api-key: wework-local-router' \
          -H 'anthropic-version: 2023-06-01' \
          --data '{"model":"wework-selected","max_tokens":32,"stream":true,"messages":[{"role":"user","content":"WEWORK_HARNESS_CLAUDE_RESPONSES_PROXY"}]}')"
        printf '%s\\n' "$proxy_status" > "$proxy_result_file"
        cat "$proxy_body_file" >> "$proxy_result_file"
        ;;
    esac
    printf '%s\\n' '{"type":"system","subtype":"init","session_id":"claude-code-e2e-session"}'
    printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Claude Code ordinary conversation reply"}]}}'
    sleep 1
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"claude-code-e2e-session"}'
    exit 0
    ;;
esac
printf '\\033[2J\\033[HClaude Code E2E harness\\r\\n'
exec sleep 600
`
      )
      await chmod(claudeCodeExecutable, 0o755)
    })(),
    (async () => {
      await mkdir(dirname(kimiCodeExecutable), { recursive: true })
      await writeFile(
        kimiCodeExecutable,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'kimi-code-e2e 3.0.0\\n'
  exit 0
fi
args_file="$HOME/${KIMI_CODE_ARGS_FILE}"
: > "$args_file"
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$args_file"
done
printf '%s\\n%s\\n%s\\n' "$KIMI_MODEL_BASE_URL" "$KIMI_MODEL_PROVIDER_TYPE" "$KIMI_CODE_HOME" > "$HOME/${KIMI_CODE_ENV_FILE}"
printf '\\033[2J\\033[HKimi Code E2E harness\\r\\n'
IFS= read -r initial_input
printf '%s\\n' "$initial_input" > "$HOME/${KIMI_CODE_INPUT_FILE}"
exec sleep 600
`
      )
      await chmod(kimiCodeExecutable, 0o755)
    })(),
  ])
  return { openCodeExecutable, claudeCodeExecutable, kimiCodeExecutable }
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

async function waitForFileSatisfying(path, validate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await readFile(path, 'utf8')
      validate(value)
      return value
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw lastError ?? new Error(`Timed out waiting for harness evidence in ${path}`)
}

async function waitForSnapshot(control, validate, message, timeoutMs) {
  const startedAt = Date.now()
  let lastSnapshot = null
  while (Date.now() - startedAt < timeoutMs) {
    lastSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    if (validate(lastSnapshot)) return lastSnapshot
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${message}: ${JSON.stringify(lastSnapshot)}`)
}

function claudeArgumentCalls(value) {
  return value
    .split('CALL\n')
    .slice(1)
    .map(call => call.trim().split('\n').filter(Boolean))
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
  const collapsedSettingsSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.match(collapsedSettingsSnapshot.text, /编码工具/)
  assert.equal(
    collapsedSettingsSnapshot.testIds.some(testId => testId.startsWith('harness-settings-panel-')),
    false,
    'Coding tool settings should start collapsed'
  )
  await capturePage(control, 'local-harness-01-settings-open.png')
  await control.command('setLocalHarnessExecutablePaths', 'body', {
    value: JSON.stringify({
      opencode: executables.openCodeExecutable,
      claude_code: executables.claudeCodeExecutable,
      kimi_code: executables.kimiCodeExecutable,
    }),
  })
  await control.command('click', '[data-testid="harness-settings-toggle-opencode"]')
  await control.command('waitFor', '[data-testid="harness-executable-path-opencode"]', {
    text: executables.openCodeExecutable,
    timeoutMs,
  })
  assert.equal(
    JSON.parse(await control.command('snapshot', 'body')).testIds.includes(
      'harness-executable-opencode'
    ),
    false,
    'Executable configuration must not expose a command-name text input'
  )
  await control.command('click', '[data-testid="harness-settings-toggle-claude_code"]')
  await control.command('waitFor', '[data-testid="harness-settings-panel-claude_code"]', {
    timeoutMs,
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
  await capturePage(control, 'local-harness-02-claude-settings.png')
  await control.command('click', '[data-testid="harness-settings-toggle-kimi_code"]')
  const kimiSettingsSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    kimiSettingsSnapshot.testIds.includes('harness-permission-mode-claude_code'),
    false,
    'Kimi Code must not inherit Claude Code-specific settings'
  )
  assert.ok(
    kimiSettingsSnapshot.testIds.includes('harness-executable-select-kimi_code'),
    'Expanded coding tools should expose the executable file picker'
  )
  await control.command('waitFor', '[data-testid="harness-settings-status"]', {
    text: '编码工具设置已自动保存',
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
  await control.command('waitFor', '[data-testid="harness-settings-kimi_code"]', {
    text: 'kimi-code-e2e 3.0.0',
    timeoutMs,
  })
  await capturePage(control, 'local-harness-03-settings-detected.png')
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
  presentation = 'terminal',
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
  await control.command('fill', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"]`, {
    value: prompt,
  })
  await capturePage(control, readyScreenshot)
  await control.command(
    'clickWhenEnabled',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
    { timeoutMs }
  )
  if (presentation === 'terminal') {
    await control.command('waitFor', CENTRAL_HARNESS_SELECTOR, { timeoutMs })
  } else {
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      {
        text: 'Claude Code ordinary conversation reply',
        timeoutMs,
      }
    )
  }
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
        '[data-testid^="local-harness-session-row-local-harness-"]',
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
      await control.command('click', '[data-testid^="local-harness-session-row-local-harness-"]')
      await control.command('waitFor', CENTRAL_HARNESS_SELECTOR, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await captureWorkbench(control, 'local-harness-09-opencode-restored.png')
      const restoredPrimarySnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        !restoredPrimarySnapshot.testIds.includes('central-harness-close-button'),
        'The primary OpenCode session exposed a close action'
      )
      await control.command('click', '[data-testid="new-chat-button"]')
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
        presentation: 'conversation',
      })
      await waitForFileSatisfying(
        join(homePath, CLAUDE_CODE_ARGS_FILE),
        value => {
          const [args] = claudeArgumentCalls(value)
          assert.ok(args, 'Claude Code invocation was not recorded')
          assert.ok(args.includes('Review the current project'))
          assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json')
          assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan')
          assert.equal(args[args.indexOf('--model') + 1], 'deepseek-v4-pro')
          assert.ok(
            !args.includes('--plugin-dir'),
            'Ordinary Claude conversation used the TUI adapter'
          )
          assert.ok(
            !args.includes('--session-id'),
            'Ordinary Claude conversation used TUI session flags'
          )
        },
        uiTimeoutMs
      )
      const claudeCodeBaseUrl = await readFileWhenReady(
        join(homePath, CLAUDE_CODE_PROXY_FILE),
        uiTimeoutMs
      )
      assert.match(
        claudeCodeBaseUrl,
        /\/v1\/harness-router\//,
        'Claude Code did not receive the ordinary conversation model router'
      )
      await waitForFileSatisfying(
        join(homePath, CLAUDE_CODE_PROXY_RESULT_FILE),
        value => {
          assert.match(value, /^200\n/, 'Claude Code could not use its active model router')
          assert.match(value, /event: message_start/, 'Claude proxy did not emit message_start')
          assert.match(value, /event: message_stop/, 'Claude proxy did not emit message_stop')
        },
        uiTimeoutMs
      )
      const claudeConversationSnapshot = await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes('message-assistant') &&
          !snapshot.testIds.includes('pause-response-button') &&
          !snapshot.testIds.includes('thinking-indicator'),
        'Claude Code ordinary turn did not settle before the follow-up',
        uiTimeoutMs
      )
      await captureWorkbench(control, 'local-harness-13-claude-code-conversation.png')
      assert.ok(
        !claudeConversationSnapshot.testIds.includes('central-harness-terminal'),
        'Claude Code still replaced the ordinary conversation with a terminal'
      )
      assert.ok(
        claudeConversationSnapshot.testIds.includes('message-assistant'),
        'Claude Code did not render its response in the ordinary conversation'
      )
      assert.ok(
        !claudeConversationSnapshot.testIds.includes('fork-runtime-task-button'),
        'Claude Code exposed the Codex-only task fork action'
      )
      await control.command(
        'fill',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"]`,
        {
          value: 'Continue in the same Claude conversation',
        }
      )
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await waitForFileSatisfying(
        join(homePath, CLAUDE_CODE_ARGS_FILE),
        value => {
          const calls = claudeArgumentCalls(value)
          assert.equal(calls.length, 2)
          const args = calls[1]
          assert.ok(args.includes('Continue in the same Claude conversation'))
          assert.equal(args[args.indexOf('--resume') + 1], 'claude-code-e2e-session')
        },
        uiTimeoutMs
      )
      await waitForSnapshot(
        control,
        snapshot =>
          !snapshot.testIds.includes('pause-response-button') &&
          !snapshot.testIds.includes('thinking-indicator'),
        'Claude Code follow-up did not settle before Goal creation',
        uiTimeoutMs
      )
      await captureWorkbench(control, 'local-harness-14-claude-code-follow-up.png')

      await control.command(
        'click',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`
      )
      await control.command('click', '[data-testid="set-goal-button"]')
      await control.command('waitFor', '[data-testid="goal-draft-pill"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'fill',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"]`,
        {
          value: 'Finish the Claude goal verification',
        }
      )
      await captureWorkbench(control, 'local-harness-15-claude-code-goal-draft.png')
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'Claude Code ordinary conversation reply',
        timeoutMs: uiTimeoutMs,
      })
      await waitForFileSatisfying(
        join(homePath, CLAUDE_CODE_ARGS_FILE),
        value => {
          const calls = claudeArgumentCalls(value)
          assert.equal(calls.length, 3)
          const args = calls[2]
          assert.ok(args.includes('/goal Finish the Claude goal verification'))
          assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan')
        },
        uiTimeoutMs
      )
      const claudeGoalSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        claudeGoalSnapshot.testIds.includes('user-message-goal-badge'),
        'Claude Goal request was not presented as a Goal message'
      )
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('goal-status-bar'),
        'Claude Goal remained active after the native /goal turn completed',
        uiTimeoutMs
      )
      await captureWorkbench(control, 'local-harness-16-claude-code-goal-complete.png')

      await control.command(
        'fill',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"]`,
        {
          value: '/compact',
        }
      )
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await waitForFileSatisfying(
        join(homePath, CLAUDE_CODE_ARGS_FILE),
        value => {
          const calls = claudeArgumentCalls(value)
          assert.equal(calls.length, 4)
          const args = calls[3]
          assert.ok(args.includes('/compact'))
          assert.equal(args[args.indexOf('--resume') + 1], 'claude-code-e2e-session')
        },
        uiTimeoutMs
      )
      await waitForSnapshot(
        control,
        snapshot =>
          !snapshot.testIds.includes('pause-response-button') &&
          !snapshot.testIds.includes('thinking-indicator'),
        'Claude Code compact turn did not settle',
        uiTimeoutMs
      )
      await captureWorkbench(control, 'local-harness-17-claude-code-compact.png')

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]', {
        timeoutMs: uiTimeoutMs,
      })
      await startHarness({
        control,
        harnessId: 'kimi_code',
        model: 'Desktop E2E Vision',
        prompt: 'Inspect the project with Kimi',
        timeoutMs: uiTimeoutMs,
        capturePage,
        runtimeMenuScreenshot: 'local-harness-15-kimi-code-runtime-menu.png',
        modelMenuScreenshot: 'local-harness-16-kimi-code-model-menu.png',
        readyScreenshot: 'local-harness-17-kimi-code-ready.png',
      })
      await captureWorkbench(control, 'local-harness-18-kimi-code-running.png')
      await verifyHarnessWorkbenchChrome({
        control,
        title: 'Inspect the project with Kimi',
        timeoutMs: uiTimeoutMs,
        captureWorkbench: capturePage,
        screenshot: 'local-harness-19-kimi-code-workbench-panels.png',
      })
      await waitForFile(
        join(homePath, KIMI_CODE_ARGS_FILE),
        '--model\n__kimi_env_model__\n',
        uiTimeoutMs
      )
      await waitForFile(
        join(homePath, KIMI_CODE_INPUT_FILE),
        '\u001b[200~Inspect the project with Kimi\u001b[201~\n',
        uiTimeoutMs
      )
      const [kimiCodeBaseUrl, kimiCodeProviderType, kimiCodeHome] = (
        await readFileWhenReady(join(homePath, KIMI_CODE_ENV_FILE), uiTimeoutMs)
      ).split('\n')
      assert.equal(kimiCodeProviderType, 'anthropic', 'Kimi Code did not use Messages mode')
      assert.ok(kimiCodeHome, 'Kimi Code did not receive an isolated home directory')
      const kimiMcpConfig = JSON.parse(await readFile(join(kimiCodeHome, 'mcp.json'), 'utf8'))
      assert.ok(
        kimiMcpConfig.mcpServers?.wework_browser,
        'Kimi Code did not receive the Wework built-in browser MCP server'
      )
      assert.match(
        await readFile(join(kimiCodeHome, 'skills', 'wework-built-in-browser', 'SKILL.md'), 'utf8'),
        /Wework built-in browser/,
        'Kimi Code did not receive the Wework built-in browser Skill'
      )
      await probeMessagesProxy(`${kimiCodeBaseUrl}/v1/messages`, 'WEWORK_HARNESS_KIMI_CHAT_PROXY')
      assert.deepEqual(harnessModelRequests, [
        { model: 'kimi-k3', protocol: 'chat' },
        { model: 'deepseek-v4-pro', protocol: 'responses' },
        { model: 'deepseek-v4-pro', protocol: 'responses' },
        { model: 'deepseek-v4-pro', protocol: 'responses' },
        { model: 'deepseek-v4-pro', protocol: 'responses' },
        { model: 'kimi-k3', protocol: 'chat' },
      ])

      await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
      await control.command('waitFor', '[data-testid="right-workspace-launcher"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-add-harness-option"]')
      await control.command('waitFor', '[data-testid="harness-session-picker"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="harness-session-picker-option-opencode"]')
      await control.command('waitFor', '[data-testid="harness-session-picker-model-selector"]', {
        text: 'Desktop E2E Vision',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="harness-session-picker-create-button"]')
      await waitForFile(
        join(homePath, OPEN_CODE_ARGS_FILE),
        '--model\nwework-messages/wework-selected\n',
        uiTimeoutMs
      )
      await control.command(
        'waitFor',
        '[data-testid^="right-workspace-harness-tab-local-harness-"]',
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', '[data-testid="workbench-pane-task-title"]', {
        text: 'Inspect the project with Kimi',
        timeoutMs: uiTimeoutMs,
      })
      const multiSessionSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        multiSessionSnapshot.testIds.filter(testId =>
          testId.startsWith('local-harness-session-row-local-harness-')
        ).length >= 2,
        'The workspace did not retain multiple harness sessions'
      )
      assert.ok(
        multiSessionSnapshot.testIds.some(testId =>
          testId.startsWith('right-workspace-harness-tab-local-harness-')
        ),
        'The additional harness session was not created in the right sidebar'
      )
      assert.ok(
        !multiSessionSnapshot.testIds.includes('central-harness-close-button'),
        'The right-sidebar harness session replaced the active primary session'
      )
      await captureWorkbench(control, 'local-harness-20-multiple-sessions.png')
      await control.command(
        'click',
        '[data-testid^="right-workspace-harness-tab-local-harness-"][data-testid$="-close-button"]'
      )
      await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
      await control.command('waitFor', '[data-testid="right-workspace-launcher"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="workbench-pane-task-title"]', {
        text: 'Inspect the project with Kimi',
        timeoutMs: uiTimeoutMs,
      })
      const closedSidebarSessionSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        !closedSidebarSessionSnapshot.testIds.some(testId =>
          testId.startsWith('right-workspace-harness-tab-local-harness-')
        ),
        'The closed right-sidebar harness tab remained mounted'
      )
      assert.ok(
        !closedSidebarSessionSnapshot.testIds.includes('desktop-empty-composer-frame'),
        'Closing the right-sidebar harness session replaced the active primary session'
      )
      await captureWorkbench(control, 'local-harness-21-session-closed.png')

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'click',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-harness-selector"]`
      )
      await control.command(
        'clickWhenEnabled',
        '[data-testid="workbench-harness-option-claude_code"]',
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'click',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-harness-model-selector"]`
      )
      await control.command(
        'click',
        '[data-testid="workbench-harness-model-option-claude_code-native"]'
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-harness-model-selector"]`,
        {
          text: '不指定模型',
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'fill',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"]`,
        {
          value: 'Use the native Claude model',
        }
      )
      await capturePage(control, 'local-harness-22-native-model-ready.png')
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'Claude Code ordinary conversation reply',
        timeoutMs: uiTimeoutMs,
      })
      await waitForFileSatisfying(
        join(homePath, CLAUDE_CODE_ARGS_FILE),
        value => {
          const args = claudeArgumentCalls(value).at(-1)
          assert.ok(args, 'Native Claude invocation was not recorded')
          assert.ok(args.includes('Use the native Claude model'))
          assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json')
          assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan')
          assert.ok(!args.includes('--model'), 'Wework overrode the native Claude model')
          assert.ok(!args.includes('--plugin-dir'), 'Native Claude used the TUI adapter')
        },
        uiTimeoutMs
      )
      await waitForFileSatisfying(
        join(homePath, CLAUDE_CODE_PROXY_FILE),
        value => {
          assert.ok(
            !value.includes('/harness-router/'),
            'Wework injected its model router while no model was selected'
          )
        },
        uiTimeoutMs
      )
      assert.deepEqual(harnessModelRequests, [
        { model: 'kimi-k3', protocol: 'chat' },
        { model: 'deepseek-v4-pro', protocol: 'responses' },
        { model: 'deepseek-v4-pro', protocol: 'responses' },
        { model: 'deepseek-v4-pro', protocol: 'responses' },
        { model: 'deepseek-v4-pro', protocol: 'responses' },
        { model: 'kimi-k3', protocol: 'chat' },
      ])
      await captureWorkbench(control, 'local-harness-23-native-model-conversation.png')
    },

    diagnostics() {
      return {
        openCodeArgsFile: join(homePath, OPEN_CODE_ARGS_FILE),
        openCodeProxyFile: join(homePath, OPEN_CODE_PROXY_FILE),
        claudeCodeArgsFile: join(homePath, CLAUDE_CODE_ARGS_FILE),
        claudeCodeEnvFile: join(homePath, CLAUDE_CODE_ENV_FILE),
        claudeCodeProxyFile: join(homePath, CLAUDE_CODE_PROXY_FILE),
        claudeCodeProxyResultFile: join(homePath, CLAUDE_CODE_PROXY_RESULT_FILE),
        kimiCodeArgsFile: join(homePath, KIMI_CODE_ARGS_FILE),
        kimiCodeEnvFile: join(homePath, KIMI_CODE_ENV_FILE),
        kimiCodeInputFile: join(homePath, KIMI_CODE_INPUT_FILE),
      }
    },
  }
}
