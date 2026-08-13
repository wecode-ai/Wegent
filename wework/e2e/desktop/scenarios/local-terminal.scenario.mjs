import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { streamingTextEvents } from '../modules/response-protocol.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const CENTRAL_HARNESS_SELECTOR = '[data-testid="central-harness-terminal"]'
const execFileAsync = promisify(execFile)
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const HARNESS_BIN_DIR = join(REPOSITORY_ROOT, '.github', 'claude-code-cli', 'node_modules', '.bin')
const HARNESS_PROMPT_MATCHERS = [
  { label: 'Inspect the current project', needle: 'Inspect the current project' },
  { label: 'Review the current project', needle: 'Review the current project' },
  { label: 'Inspect the project with Kimi', needle: 'Inspect the project with Kimi' },
]

async function resolveHarnessExecutables() {
  const executables = {
    openCodeExecutable: join(HARNESS_BIN_DIR, 'opencode'),
    claudeCodeExecutable: join(HARNESS_BIN_DIR, 'claude'),
    kimiCodeExecutable: join(HARNESS_BIN_DIR, 'kimi'),
  }
  await Promise.all(
    Object.values(executables).map(executablePath => access(executablePath, constants.X_OK))
  )
  const versions = await Promise.all(
    Object.values(executables).map(async executablePath => {
      const { stdout } = await execFileAsync(executablePath, ['--version'])
      return stdout.trim().split('\n')[0]
    })
  )
  return {
    ...executables,
    openCodeVersion: versions[0],
    claudeCodeVersion: versions[1],
    kimiCodeVersion: versions[2],
  }
}

async function waitForRequests(requests, validate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      validate(requests)
      return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw lastError ?? new Error('Timed out waiting for real harness CLI requests')
}

function assertPromptRequest(requests, prompt, model, protocol) {
  assert.ok(
    requests.some(
      request =>
        request.prompt === prompt && request.model === model && request.protocol === protocol
    ),
    `No real ${model} ${protocol} request contained ${JSON.stringify(prompt)}: ${JSON.stringify(requests)}`
  )
}

async function submitHarnessPrompt(control, prompt, timeoutMs) {
  const composerSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"]`
  await control.command('fill', composerSelector, { value: prompt })
  await control.command(
    'clickWhenEnabled',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
    { timeoutMs }
  )
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

function writeResponsesText(response, text) {
  const stream = streamingTextEvents('harness-responses', text)
  const events = [
    ...stream.start,
    ...stream.chunks.map((delta, index) => ({
      type: 'response.output_text.delta',
      item_id: stream.itemId,
      output_index: 0,
      content_index: 0,
      delta,
      offset: stream.chunks.slice(0, index).join('').length,
    })),
    ...stream.finish,
  ]
  writeSse(
    response,
    events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  )
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
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="harness-settings-claude_code"]', {
    text: executables.claudeCodeVersion,
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="harness-settings-kimi_code"]', {
    text: executables.kimiCodeVersion,
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
  const composerSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"]`
  await control.command('fill', composerSelector, { value: prompt })
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
        text: 'Local harness CLI reply',
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
    /(?:^|\s)pointer-events-auto(?:\s|$)/,
    `${title} did not make the open bottom workspace panel interactive`
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
    bottomPanelMetrics.height >= 220,
    `${title} opened an undersized bottom workspace panel`
  )
  assert.ok(
    bottomPanelMetrics.scrollHeight > 0,
    `${title} opened a bottom workspace panel without content`
  )
  await captureWorkbench(control, screenshot)

  await control.command('click', bottomPanelToggleSelector)
  await control.command('click', rightPanelToggleSelector)
}

export async function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  const executables = await resolveHarnessExecutables()
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
      const serializedBody = JSON.stringify(body)
      harnessModelRequests.push({
        model: body.model,
        protocol: expected.protocol,
        prompt:
          HARNESS_PROMPT_MATCHERS.findLast(({ needle }) => serializedBody.includes(needle))
            ?.label ?? 'auxiliary',
      })

      if (expected.protocol === 'chat') {
        writeSse(response, [
          `data: ${JSON.stringify({
            id: 'harness-chat',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'Local harness CLI reply' },
                finish_reason: null,
              },
            ],
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

      writeResponsesText(response, 'Local harness CLI reply')
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
      await waitForRequests(
        harnessModelRequests,
        requests => assertPromptRequest(requests, 'Inspect the current project', 'kimi-k3', 'chat'),
        uiTimeoutMs
      )

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
        harnessId: 'kimi_code',
        model: 'Desktop E2E Vision',
        prompt: 'Inspect the project with Kimi',
        timeoutMs: uiTimeoutMs,
        capturePage,
        runtimeMenuScreenshot: 'local-harness-10-kimi-code-runtime-menu.png',
        modelMenuScreenshot: 'local-harness-11-kimi-code-model-menu.png',
        readyScreenshot: 'local-harness-12-kimi-code-ready.png',
      })
      await captureWorkbench(control, 'local-harness-13-kimi-code-running.png')
      await verifyHarnessWorkbenchChrome({
        control,
        title: 'Inspect the project with Kimi',
        timeoutMs: uiTimeoutMs,
        captureWorkbench: capturePage,
        screenshot: 'local-harness-14-kimi-code-workbench-panels.png',
      })
      await waitForRequests(
        harnessModelRequests,
        requests =>
          assertPromptRequest(requests, 'Inspect the project with Kimi', 'kimi-k3', 'chat'),
        uiTimeoutMs
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
        runtimeMenuScreenshot: 'local-harness-15-claude-code-runtime-menu.png',
        modelMenuScreenshot: 'local-harness-16-claude-code-model-menu.png',
        readyScreenshot: 'local-harness-17-claude-code-ready.png',
        presentation: 'conversation',
      })
      await waitForRequests(
        harnessModelRequests,
        requests =>
          assertPromptRequest(
            requests,
            'Review the current project',
            'deepseek-v4-pro',
            'responses'
          ),
        uiTimeoutMs
      )
      const claudeConversationSnapshot = await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes('message-assistant') &&
          !snapshot.testIds.includes('pause-response-button') &&
          !snapshot.testIds.includes('thinking-indicator'),
        'Claude Code ordinary turn did not settle',
        uiTimeoutMs
      )
      await captureWorkbench(control, 'local-harness-18-claude-code-conversation.png')
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
    },

    diagnostics() {
      return {
        openCodeExecutable: executables.openCodeExecutable,
        claudeCodeExecutable: executables.claudeCodeExecutable,
        kimiCodeExecutable: executables.kimiCodeExecutable,
        harnessModelRequests,
      }
    },
  }
}
