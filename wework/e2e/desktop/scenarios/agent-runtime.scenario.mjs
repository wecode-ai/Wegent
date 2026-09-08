import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { localHarnessCliPath, localHarnessCliVersion } from '../modules/local-harness-cli.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createSingleRootLocalProject, DEFAULT_MODEL_LABEL } from '../modules/shared.mjs'
import {
  responseCompleted,
  responseCreated,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const ACTIVE_WORKSPACE_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKSPACE_SELECTOR} ${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const CLAUDE_BINARY = localHarnessCliPath(
  join(REPOSITORY_ROOT, '.github', 'claude-code-cli', 'node_modules', '.bin'),
  'claude'
)
const TEAM_NAME = `agent-runtime-e2e-team-${process.pid}`
const BOT_NAME = `agent-runtime-e2e-bot-${process.pid}`
const AGENT_LABEL = '统一运行时验收智能体'
const SYSTEM_PROMPT_MARKER = 'WEWORK_AGENT_RUNTIME_SYSTEM_PROMPT_20260908'
const CLAUDE_PROMPT = 'WEWORK_AGENT_RUNTIME_CLAUDE: verify the remote agent configuration.'
const CLAUDE_COMPLETION = 'WEWORK_AGENT_RUNTIME_CLAUDE_COMPLETE'
const CODEX_PROMPT = 'WEWORK_AGENT_RUNTIME_CODEX: verify the remote agent configuration.'
const CODEX_COMPLETION = 'WEWORK_AGENT_RUNTIME_CODEX_COMPLETE'

async function requestJson(backendUrl, authToken, path, init = {}) {
  const response = await fetch(`${backendUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  assert.ok(response.ok, `${init.method ?? 'GET'} ${path} failed with ${response.status}: ${text}`)
  return body
}

function writeText(response, id, text) {
  const stream = streamingTextEvents(id, text)
  const events = [
    responseCreated(id),
    ...stream.start,
    ...stream.chunks.map(delta => ({
      type: 'response.output_text.delta',
      item_id: stream.itemId,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    ...stream.finish,
    responseCompleted(id),
  ]
  response.writeHead(200, {
    'cache-control': 'no-cache',
    'content-type': 'text/event-stream; charset=utf-8',
  })
  response.end(
    events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  )
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function configureClaude(control, version, timeoutMs) {
  await control.command('click', '[data-testid="settings-button"]')
  await control.command('click', '[data-testid="settings-menu-button"]')
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (!snapshot.testIds.includes('settings-nav-harnesses')) {
    await control.command('waitFor', '[data-testid="general-experimental-features-toggle"]', {
      timeoutMs,
    })
    await control.command('click', '[data-testid="general-experimental-features-toggle"]')
    await control.command('waitFor', '[data-testid="settings-nav-harnesses"]', { timeoutMs })
  }
  await control.command('click', '[data-testid="settings-nav-harnesses"]')
  await control.command('waitFor', '[data-testid="harness-settings-page"]', { timeoutMs })
  await control.command('setLocalHarnessExecutablePaths', 'body', {
    value: JSON.stringify({ claude_code: CLAUDE_BINARY }),
  })
  await control.command('waitFor', '[data-testid="harness-settings-claude_code"]', {
    text: version,
    timeoutMs,
  })
  await control.command('click', '[data-testid="settings-back-button"]')
}

async function selectAgent(control, teamId, timeoutMs) {
  const agentSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-agent-selector"]`
  const runtimeSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-runtime-selector"]`
  assert.equal(
    Number(await control.command('getElementCount', agentSelector)),
    1,
    'Wework must expose exactly one remote-agent selector'
  )
  assert.equal(
    Number(await control.command('getElementCount', runtimeSelector)),
    1,
    'Wework must expose exactly one runtime selector'
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-harness-selector"]`
      )
    ),
    0,
    'The obsolete mixed agent/runtime selector must be removed'
  )
  await control.command('click', agentSelector)
  await control.command('waitFor', `[data-testid="workbench-agent-option-${teamId}"]`, {
    text: AGENT_LABEL,
    timeoutMs,
    visible: true,
  })
  await control.command('click', `[data-testid="workbench-agent-option-${teamId}"]`)
  await control.command('waitFor', agentSelector, {
    text: AGENT_LABEL,
    timeoutMs,
    visible: true,
  })
  await control.command('waitFor', runtimeSelector, {
    text: 'Claude Code',
    timeoutMs,
    visible: true,
  })
}

async function selectRuntime(control, runtime, timeoutMs) {
  const runtimeSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-runtime-selector"]`
  await control.command('click', runtimeSelector)
  await control.command('clickWhenEnabled', `[data-testid="workbench-runtime-option-${runtime}"]`, {
    timeoutMs,
  })
  await control.command('waitFor', runtimeSelector, {
    text: runtime === 'codex' ? 'Codex' : 'Claude Code',
    timeoutMs,
    visible: true,
  })
}

async function captureSelectorMenus(control, captureScreenshot, teamId, timeoutMs) {
  const agentSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-agent-selector"]`
  const runtimeSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-runtime-selector"]`

  await control.command('click', agentSelector)
  await control.command('waitFor', '[data-testid="workbench-agent-selector-menu"]', {
    timeoutMs,
    visible: true,
  })
  await control.command('waitFor', `[data-testid="workbench-agent-option-${teamId}"]`, {
    text: AGENT_LABEL,
    timeoutMs,
    visible: true,
  })
  await captureScreenshot(control, 'agent-runtime-01-agent-menu-complete.png')
  await control.command('press', agentSelector, { key: 'Escape' })

  await control.command('click', runtimeSelector)
  await control.command('waitFor', '[data-testid="workbench-runtime-selector-menu"]', {
    timeoutMs,
    visible: true,
  })
  await control.command('waitFor', '[data-testid="workbench-runtime-option-codex"]', {
    text: 'Codex',
    timeoutMs,
    visible: true,
  })
  await control.command('waitFor', '[data-testid="workbench-runtime-option-claude_code"]', {
    text: 'Claude Code',
    timeoutMs,
    visible: true,
  })
  await captureScreenshot(control, 'agent-runtime-02-runtime-menu-complete.png')
  await control.command('press', runtimeSelector, { key: 'Escape' })
}

async function sendAndWait(control, prompt, completion, timeoutMs) {
  await control.command('fill', COMPOSER_SELECTOR, { value: prompt })
  await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: completion,
    timeoutMs,
  })
}

export async function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  await access(CLAUDE_BINARY, constants.X_OK)
  const claudeVersion = await localHarnessCliVersion(CLAUDE_BINARY)
  const modelRequests = []
  let teamId = null

  return {
    claudeBinary: CLAUDE_BINARY,
    requiresCloudEnvironment: true,

    async prepareCloud({ authToken, backendUrl }) {
      const bot = await requestJson(backendUrl, authToken, '/api/bots', {
        method: 'POST',
        body: JSON.stringify({
          name: BOT_NAME,
          shell_name: 'ClaudeCode',
          agent_config: {
            bind_model: 'desktop-e2e-public-model',
            bind_model_type: 'public',
          },
          system_prompt: SYSTEM_PROMPT_MARKER,
          namespace: 'default',
          is_active: true,
        }),
      })
      const team = await requestJson(backendUrl, authToken, '/api/teams', {
        method: 'POST',
        body: JSON.stringify({
          name: TEAM_NAME,
          displayName: AGENT_LABEL,
          description: 'Wework local Claude Code and Codex runtime E2E agent',
          bots: [{ bot_id: bot.id, role: 'leader', bot_prompt: '' }],
          workflow: { mode: 'solo' },
          bind_mode: ['wework'],
          namespace: 'default',
          is_active: true,
        }),
      })
      teamId = Number(team.id)
      assert.ok(teamId > 0, 'Remote agent fixture did not return a Team id')
    },

    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readJson(request)
      const serialized = JSON.stringify(body)
      const prompt = [CLAUDE_PROMPT, CODEX_PROMPT].find(candidate => serialized.includes(candidate))
      if (!prompt) return false
      modelRequests.push({ prompt, body })
      assert.ok(
        serialized.includes(SYSTEM_PROMPT_MARKER),
        `Remote agent system prompt was missing from the ${prompt} request`
      )
      writeText(
        response,
        `agent-runtime-${Date.now()}`,
        prompt === CLAUDE_PROMPT ? CLAUDE_COMPLETION : CODEX_COMPLETION
      )
      return true
    },

    async verify(control) {
      assert.ok(teamId, 'Remote agent fixture was not prepared')
      await ensureExperimentalFeaturesEnabled(control)
      await createSingleRootLocalProject(control, workspacePath, 'agent-runtime-e2e')
      await configureClaude(control, claudeVersion, uiTimeoutMs)

      await selectAgent(control, teamId, uiTimeoutMs)
      await captureSelectorMenus(control, captureScreenshot, teamId, uiTimeoutMs)
      await captureScreenshot(control, 'agent-runtime-03-agent-and-runtime-selectors.png')
      await sendAndWait(control, CLAUDE_PROMPT, CLAUDE_COMPLETION, 60_000)
      await captureScreenshot(control, 'agent-runtime-04-claude-completed.png')

      await control.command('click', '[data-testid="new-chat-button"]')
      await selectAgent(control, teamId, uiTimeoutMs)
      await selectRuntime(control, 'codex', uiTimeoutMs)
      await captureScreenshot(control, 'agent-runtime-05-codex-override.png')
      await sendAndWait(control, CODEX_PROMPT, CODEX_COMPLETION, 60_000)
      await captureScreenshot(control, 'agent-runtime-06-codex-completed.png')

      assert.deepEqual(
        new Set(modelRequests.map(item => item.prompt)),
        new Set([CLAUDE_PROMPT, CODEX_PROMPT]),
        'Both local runtimes must consume the same remote agent configuration'
      )
      const bodyText = await control.command('getText', 'body')
      assert.equal(
        (bodyText.match(/Codex/g) ?? []).length < 3,
        true,
        'The composer exposed duplicate Codex controls'
      )
      assert.ok(
        bodyText.includes(DEFAULT_MODEL_LABEL) || modelRequests.length === 2,
        'The runtime model contract was not observable'
      )
    },
  }
}
