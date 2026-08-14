import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  responseCompleted,
  responseCreated,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const ACTIVE_WORKSPACE_TAB_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const CLAUDE_BINARY = join(
  REPOSITORY_ROOT,
  '.github',
  'claude-code-cli',
  'node_modules',
  '.bin',
  'claude'
)
const MODEL_LABEL = 'Desktop E2E DeepSeek Pro Vision Main'
const REMOTE_MODEL_LABEL = 'desktop-e2e-cloud-responses-upstream'
const LOCAL_INITIAL_PROMPT =
  'WEWORK_CLAUDE_LOCAL_INITIAL: create the requested local verification file.'
const LOCAL_INITIAL_COMPLETION = 'WEWORK_CLAUDE_LOCAL_INITIAL_COMPLETE'
const LOCAL_FOLLOW_UP_PROMPT =
  'WEWORK_CLAUDE_LOCAL_FOLLOW_UP: confirm the previous local operation remains in context.'
const LOCAL_FOLLOW_UP_COMPLETION = 'WEWORK_CLAUDE_LOCAL_FOLLOW_UP_COMPLETE'
const LOCAL_CANCELLATION_PROMPT =
  'WEWORK_CLAUDE_LOCAL_CANCELLATION: wait until this response is stopped.'
const LOCAL_CANCELLATION_COMPLETION = 'WEWORK_CLAUDE_LOCAL_CANCELLATION_LATE_COMPLETE'
const REMOTE_INITIAL_PROMPT =
  'WEWORK_CLAUDE_REMOTE_INITIAL: create the requested remote verification file.'
const REMOTE_INITIAL_COMPLETION = 'WEWORK_CLAUDE_REMOTE_INITIAL_COMPLETE'
const REMOTE_FOLLOW_UP_PROMPT =
  'WEWORK_CLAUDE_REMOTE_FOLLOW_UP: confirm the previous remote operation remains in context.'
const REMOTE_FOLLOW_UP_COMPLETION = 'WEWORK_CLAUDE_REMOTE_FOLLOW_UP_COMPLETE'
const LOCAL_ARTIFACT = 'claude-local-e2e.txt'
const LOCAL_ARTIFACT_CONTENT = 'WEWORK_CLAUDE_LOCAL_ARTIFACT'
const REMOTE_ARTIFACT = 'claude-remote-e2e.txt'
const REMOTE_ARTIFACT_CONTENT = 'WEWORK_CLAUDE_REMOTE_ARTIFACT'
const execFileAsync = promisify(execFile)

function sse(response, events) {
  response.writeHead(200, {
    'cache-control': 'no-cache',
    'content-type': 'text/event-stream; charset=utf-8',
  })
  response.end(
    events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  )
}

function writeText(response, id, text) {
  const stream = streamingTextEvents(id, text)
  sse(response, [
    ...stream.start,
    ...stream.chunks.map(delta => ({
      type: 'response.output_text.delta',
      item_id: stream.itemId,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    ...stream.finish,
  ])
}

function writeBashToolCall(response, id, callId, command) {
  const argumentsText = JSON.stringify({
    command,
    description: 'Create the Claude Code desktop E2E verification artifact',
  })
  sse(response, [
    responseCreated(id),
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: `${id}-item`,
        type: 'function_call',
        call_id: callId,
        name: 'Bash',
      },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: `${id}-item`,
      delta: argumentsText,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: `${id}-item`,
        type: 'function_call',
        call_id: callId,
        name: 'Bash',
        arguments: argumentsText,
      },
    },
    responseCompleted(id),
  ])
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function waitFor(condition, message, timeoutMs) {
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await condition()) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw lastError ?? new Error(message)
}

async function waitForNewTaskRow(control, knownRows, timeoutMs) {
  let rowTestId = null
  await waitFor(
    async () => {
      const snapshot = JSON.parse(await control.command('snapshot', 'body'))
      rowTestId = snapshot.testIds.find(
        testId => testId.startsWith('runtime-local-task-row-') && !knownRows.has(testId)
      )
      return Boolean(rowTestId)
    },
    'Claude Code did not create a runtime task row',
    timeoutMs
  )
  return rowTestId
}

async function waitForTaskIdle(control, taskRowTestId, timeoutMs) {
  const taskId = taskRowTestId.slice('runtime-local-task-row-'.length)
  const runningSelector =
    `${ACTIVE_WORKSPACE_TAB_SELECTOR} ` + `[data-testid="runtime-local-task-running-${taskId}"]`
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (
        Number(
          await control.command('getElementCount', runningSelector, {
            visible: true,
          })
        ) === 0
      ) {
        return
      }
    } catch (error) {
      lastError = error
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }
  throw lastError ?? new Error(`Claude Code task ${taskId} did not become visibly idle`)
}

async function configureClaude(control, executablePath, version, timeoutMs) {
  await control.command('click', '[data-testid="settings-button"]')
  await control.command('click', '[data-testid="settings-menu-button"]')
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (!snapshot.testIds.includes('settings-nav-harnesses')) {
    await control.command('click', '[data-testid="general-experimental-features-toggle"]')
    await control.command('waitFor', '[data-testid="settings-nav-harnesses"]', { timeoutMs })
  }
  await control.command('click', '[data-testid="settings-nav-harnesses"]')
  await control.command('waitFor', '[data-testid="harness-settings-page"]', { timeoutMs })
  await control.command('setLocalHarnessExecutablePaths', 'body', {
    value: JSON.stringify({ claude_code: executablePath }),
  })
  await control.command('waitFor', '[data-testid="harness-settings-claude_code"]', {
    text: version,
    timeoutMs,
  })
  await control.command('click', '[data-testid="settings-back-button"]')
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
    value: 'claude-local-runtime-e2e',
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'claude-local-runtime-e2e',
    timeoutMs,
  })
}

async function createRemoteProject(control, workspacePath, timeoutMs) {
  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-remote-option"]')
  await control.command('waitFor', '[data-testid="standalone-remote-device-select"]', {
    timeoutMs,
  })
  await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
    value: 'wework-e2e-cloud-device',
  })
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', { timeoutMs })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    timeoutMs,
  })
  let remoteProjectRow = null
  await waitFor(
    async () => {
      const snapshot = JSON.parse(await control.command('snapshot', 'body'))
      for (const testId of snapshot.testIds.filter(testId => testId.startsWith('project-row-'))) {
        const selector = `[data-testid="${testId}"]`
        const text = await control.command('getText', selector)
        const remoteStatusCount = Number(
          await control.command(
            'getElementCount',
            `${selector} [data-testid^="project-device-status-"]`
          )
        )
        if (text.includes('claude-remote-workspace') && remoteStatusCount > 0) {
          remoteProjectRow = testId
          return true
        }
      }
      return false
    },
    'The remote Claude project did not stabilize on its cloud device',
    timeoutMs
  )
  assert.ok(remoteProjectRow, 'The remote Claude project identity was unavailable')
  await control.command(
    'clickWhenEnabled',
    `[data-testid="${remoteProjectRow}"] [data-testid="project-new-conversation-button"]`,
    { timeoutMs }
  )
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'claude-remote-workspace',
    stableMs: 300,
    timeoutMs,
  })
  await control.command('waitFor', COMPOSER_SELECTOR, { stableMs: 300, timeoutMs })
}

async function selectClaudeRuntime(control, modelLabel, timeoutMs) {
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-harness-selector"]`
  )
  await control.command(
    'clickWhenEnabled',
    '[data-testid="workbench-harness-option-claude_code"]',
    {
      timeoutMs,
    }
  )
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-harness-model-selector"]`
  )
  await control.command(
    'clickDescendantInElementWithText',
    '[data-testid^="workbench-harness-model-option-claude_code-"]',
    {
      text: modelLabel,
      target: 'span',
      timeoutMs,
    }
  )
  await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs })
}

async function sendNewClaudeTask(control, prompt, completion, runtimeTimeoutMs) {
  const knownRows = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('fill', COMPOSER_SELECTOR, { value: prompt })
  await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
  const taskRow = await waitForNewTaskRow(control, knownRows, runtimeTimeoutMs)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: completion,
    timeoutMs: runtimeTimeoutMs,
  })
  return taskRow
}

export async function createDesktopScenario({ resultDir, uiTimeoutMs, workspacePath }) {
  await access(CLAUDE_BINARY, constants.X_OK)
  const { stdout } = await execFileAsync(CLAUDE_BINARY, ['--version'])
  const claudeVersion = stdout.trim().split('\n')[0]
  const localClaudeAlias = join(resultDir, 'local-claude')
  const remoteWorkspacePath = join(resultDir, 'claude-remote-workspace')
  await rm(localClaudeAlias, { force: true })
  await symlink(CLAUDE_BINARY, localClaudeAlias)
  await mkdir(remoteWorkspacePath, { recursive: true })
  await writeFile(join(remoteWorkspacePath, 'README.md'), '# Claude remote E2E\n', 'utf8')

  const requests = []
  let active = false
  let cloudEnvironment = null
  let lateCancellationCompleted = false
  let releaseCancellation
  const cancellationRelease = new Promise(resolvePromise => {
    releaseCancellation = resolvePromise
  })

  return {
    claudeBinary: CLAUDE_BINARY,
    remoteWorkspacePath,
    requiresCloudEnvironment: true,

    setCloudEnvironment(value) {
      cloudEnvironment = value
    },

    async handleHttp(request, response, url) {
      if (!active || request.method !== 'POST') return false
      if (!['/v1/responses', '/responses'].includes(url.pathname)) return false

      const body = await readJson(request)
      const serialized = JSON.stringify(body)
      const prompt = [
        LOCAL_CANCELLATION_PROMPT,
        LOCAL_FOLLOW_UP_PROMPT,
        REMOTE_FOLLOW_UP_PROMPT,
        LOCAL_INITIAL_PROMPT,
        REMOTE_INITIAL_PROMPT,
      ].find(candidate => serialized.includes(candidate))
      if (!prompt) {
        writeText(response, `claude-auxiliary-${Date.now()}`, '')
        return true
      }
      requests.push({ body, prompt })

      if (prompt === LOCAL_CANCELLATION_PROMPT) {
        response.writeHead(200, {
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'content-type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(
          `event: response.created\ndata: ${JSON.stringify(responseCreated('claude-cancel'))}\n\n`
        )
        await cancellationRelease
        if (!response.destroyed) {
          const stream = streamingTextEvents('claude-cancel-late', LOCAL_CANCELLATION_COMPLETION)
          response.end(
            [
              ...stream.start,
              ...stream.chunks.map(delta => ({
                type: 'response.output_text.delta',
                item_id: stream.itemId,
                output_index: 0,
                content_index: 0,
                delta,
              })),
              ...stream.finish,
            ]
              .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join('')
          )
        }
        lateCancellationCompleted = true
        return true
      }

      if (prompt === LOCAL_INITIAL_PROMPT || prompt === REMOTE_INITIAL_PROMPT) {
        const outputIds = (body.input ?? [])
          .filter(item => item?.type === 'function_call_output')
          .map(item => item.call_id)
        const local = prompt === LOCAL_INITIAL_PROMPT
        const callId = local ? 'claude-local-write' : 'claude-remote-write'
        if (!outputIds.includes(callId)) {
          assert.ok(
            body.tools?.some(tool => tool?.name === 'Bash'),
            'Claude Code did not advertise its Bash tool'
          )
          writeBashToolCall(
            response,
            local ? 'claude-local-tool' : 'claude-remote-tool',
            callId,
            local
              ? `printf '${LOCAL_ARTIFACT_CONTENT}' > ${LOCAL_ARTIFACT}`
              : `printf '${REMOTE_ARTIFACT_CONTENT}' > ${REMOTE_ARTIFACT}`
          )
        } else {
          writeText(
            response,
            local ? 'claude-local-complete' : 'claude-remote-complete',
            local ? LOCAL_INITIAL_COMPLETION : REMOTE_INITIAL_COMPLETION
          )
        }
        return true
      }

      assert.ok(
        serialized.includes(
          prompt === LOCAL_FOLLOW_UP_PROMPT ? LOCAL_INITIAL_PROMPT : REMOTE_INITIAL_PROMPT
        ),
        'Claude Code follow-up did not preserve the preceding conversation context'
      )
      writeText(
        response,
        prompt === LOCAL_FOLLOW_UP_PROMPT ? 'claude-local-follow-up' : 'claude-remote-follow-up',
        prompt === LOCAL_FOLLOW_UP_PROMPT ? LOCAL_FOLLOW_UP_COMPLETION : REMOTE_FOLLOW_UP_COMPLETION
      )
      return true
    },

    async verify(control) {
      active = true
      assert.ok(cloudEnvironment, 'Claude runtime E2E did not receive its cloud environment')
      const runtimeTimeoutMs = 60_000

      await createLocalProject(control, workspacePath, uiTimeoutMs)
      await configureClaude(control, localClaudeAlias, claudeVersion, uiTimeoutMs)
      await selectClaudeRuntime(control, MODEL_LABEL, uiTimeoutMs)
      const localTaskRow = await sendNewClaudeTask(
        control,
        LOCAL_INITIAL_PROMPT,
        LOCAL_INITIAL_COMPLETION,
        runtimeTimeoutMs
      )
      assert.equal(
        (await readFile(join(workspacePath, LOCAL_ARTIFACT), 'utf8')).trim(),
        LOCAL_ARTIFACT_CONTENT,
        'The local Claude Code executor did not create its artifact'
      )
      await waitForTaskIdle(control, localTaskRow, runtimeTimeoutMs)
      await control.command('fill', COMPOSER_SELECTOR, { value: LOCAL_FOLLOW_UP_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: LOCAL_FOLLOW_UP_COMPLETION,
        timeoutMs: runtimeTimeoutMs,
      })
      await waitForTaskIdle(control, localTaskRow, runtimeTimeoutMs)
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('click', `[data-testid="${localTaskRow}"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: LOCAL_FOLLOW_UP_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      await control.command('fill', COMPOSER_SELECTOR, { value: LOCAL_CANCELLATION_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await waitFor(
        () => requests.some(item => item.prompt === LOCAL_CANCELLATION_PROMPT),
        'The real Claude Code CLI did not send the cancellation request',
        runtimeTimeoutMs
      )
      await control.command('waitFor', '[data-testid="pause-response-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="pause-response-button"]')
      await control.command('waitFor', '[data-testid="assistant-stopped-notice"]', {
        timeoutMs: uiTimeoutMs,
      })
      releaseCancellation()
      await waitFor(
        () => lateCancellationCompleted,
        'The mock did not complete the post-cancellation stream attempt',
        runtimeTimeoutMs
      )
      await control.command('waitFor', '[data-testid="assistant-stopped-notice"]', {
        stableMs: 500,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        (await control.command('getText', 'body')).includes(LOCAL_CANCELLATION_COMPLETION),
        false,
        'The local Claude Code task rendered content emitted after cancellation'
      )

      await createRemoteProject(control, remoteWorkspacePath, uiTimeoutMs)
      await selectClaudeRuntime(control, REMOTE_MODEL_LABEL, uiTimeoutMs)
      const remoteTaskRow = await sendNewClaudeTask(
        control,
        REMOTE_INITIAL_PROMPT,
        REMOTE_INITIAL_COMPLETION,
        runtimeTimeoutMs
      )
      assert.equal(
        (await readFile(join(remoteWorkspacePath, REMOTE_ARTIFACT), 'utf8')).trim(),
        REMOTE_ARTIFACT_CONTENT,
        'The remote Claude Code executor did not create its artifact'
      )
      const remoteExecutorRuntimeLog = join(resultDir, 'cloud-executor-runtime.log')
      await waitFor(
        async () => {
          const log = await readFile(remoteExecutorRuntimeLog, 'utf8')
          assert.match(
            log,
            new RegExp(
              `agent=ClaudeCode program=${CLAUDE_BINARY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
            ),
            'The remote executor did not use its own Claude binary'
          )
          assert.equal(
            log.includes(`agent=ClaudeCode program=${localClaudeAlias}`),
            false,
            'The remote executor received the desktop-local Claude executable path'
          )
          return true
        },
        'The remote executor did not log its Claude Code command',
        runtimeTimeoutMs
      )
      await waitForTaskIdle(control, remoteTaskRow, runtimeTimeoutMs)
      await control.command('fill', COMPOSER_SELECTOR, { value: REMOTE_FOLLOW_UP_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: REMOTE_FOLLOW_UP_COMPLETION,
        timeoutMs: runtimeTimeoutMs,
      })
      await waitForTaskIdle(control, remoteTaskRow, runtimeTimeoutMs)
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('click', `[data-testid="${remoteTaskRow}"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: REMOTE_FOLLOW_UP_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      for (const prompt of [
        LOCAL_INITIAL_PROMPT,
        LOCAL_FOLLOW_UP_PROMPT,
        LOCAL_CANCELLATION_PROMPT,
        REMOTE_INITIAL_PROMPT,
        REMOTE_FOLLOW_UP_PROMPT,
      ]) {
        assert.ok(
          requests.some(item => item.prompt === prompt),
          `The real Claude Code CLI did not send ${prompt}`
        )
      }
      await rm(localClaudeAlias, { force: true })
    },
  }
}
