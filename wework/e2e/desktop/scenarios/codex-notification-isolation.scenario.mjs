import assert from 'node:assert/strict'

import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const ACTIVE_WORKSPACE_TAB_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const PROMPTS = {
  quiet: 'WEWORK_E2E_CODEX_NOTIFICATION_QUIET',
  noisy: 'WEWORK_E2E_CODEX_NOTIFICATION_NOISY',
}
const COMPLETIONS = {
  quiet: 'WEWORK_E2E_CODEX_NOTIFICATION_QUIET_COMPLETE',
  noisy: 'WEWORK_E2E_CODEX_NOTIFICATION_NOISY_COMPLETE',
}
const NOISE_DELTA_COUNT = 2200

function sse(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function streamStart(id) {
  const itemId = `${id}-message`
  return [
    responseCreated(id),
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
        phase: 'final_answer',
      },
    },
    {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
  ]
}

function streamFinish(id, text) {
  const itemId = `${id}-message`
  return [
    {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
        phase: 'final_answer',
      },
    },
    {
      type: 'response.completed',
      response: {
        id,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ]
}

async function waitForNewTaskRow(control, knownRows, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const next = snapshot.testIds.find(
      testId => testId.startsWith('runtime-local-task-row-') && !knownRows.has(testId)
    )
    if (next) return next
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for a Codex notification isolation task')
}

async function sendTask(control, newConversationSelector, knownRows, prompt, timeoutMs) {
  await control.command('clickWhenEnabled', newConversationSelector, { timeoutMs })
  await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs })
  await control.command('fill', COMPOSER_SELECTOR, { value: prompt })
  await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
  const rowTestId = await waitForNewTaskRow(control, knownRows, timeoutMs)
  knownRows.add(rowTestId)
  return {
    rowTestId,
    taskId: rowTestId.replace('runtime-local-task-row-', ''),
  }
}

async function waitForRequestCount(requests, count, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (requests.length >= count) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${count} notification isolation requests`)
}

async function selectTask(control, sidebar, task, timeoutMs) {
  const rowSelector = `${sidebar} [data-testid="${task.rowTestId}"]`
  await control.command('scrollIntoView', rowSelector)
  await control.command('waitFor', rowSelector, { timeoutMs, visible: true })
  await control.command('click', rowSelector, { visible: true })

  const startedAt = Date.now()
  let lastTaskId = null
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    lastTaskId = snapshot.workbench?.currentRuntimeTask?.taskId ?? null
    if (lastTaskId === task.taskId) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(
    `Timed out selecting notification isolation task ${task.taskId}; active task was ${lastTaskId}`
  )
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  let active = false
  const requests = []
  const streams = new Map()
  let emitted = false

  const emitBurstAndCompletions = () => {
    if (emitted || streams.size !== 2) return
    emitted = true
    const noisy = streams.get(PROMPTS.noisy)
    const quiet = streams.get(PROMPTS.quiet)
    for (let index = 0; index < NOISE_DELTA_COUNT; index += 1) {
      noisy.response.write(
        sse({
          type: 'response.output_text.delta',
          item_id: noisy.itemId,
          output_index: 0,
          content_index: 0,
          delta: 'x',
        })
      )
    }
    for (const event of streamFinish(noisy.id, COMPLETIONS.noisy)) {
      noisy.response.write(sse(event))
    }
    noisy.response.end()
    for (const event of streamFinish(quiet.id, COMPLETIONS.quiet)) {
      quiet.response.write(sse(event))
    }
    quiet.response.end()
  }

  return {
    async handleHttp(request, response, url) {
      if (!active || request.method !== 'POST') return false
      if (!['/v1/responses', '/responses'].includes(url.pathname)) return false

      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const requestText = JSON.stringify(body)
      const prompt = Object.values(PROMPTS).find(candidate => requestText.includes(candidate))
      if (!prompt) return false
      if (streams.has(prompt)) {
        const message = `Received duplicate notification isolation request for ${prompt}`
        response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(`${JSON.stringify({ error: message })}\n`)
        throw new Error(message)
      }

      requests.push(prompt)
      const id = `wework-notification-isolation-${requests.length}`
      const itemId = `${id}-message`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.flushHeaders()
      for (const event of streamStart(id)) response.write(sse(event))
      streams.set(prompt, { id, itemId, response })
      emitBurstAndCompletions()
      return true
    },

    async verify(control) {
      active = true
      await control.command('waitFor', '[data-testid="settings-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      const shellSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      if (shellSnapshot.testIds.includes('desktop-sidebar-hover-edge')) {
        await control.command('toggleSidebar', 'body')
        await control.command('waitFor', '[data-testid="desktop-sidebar"]', {
          timeoutMs: uiTimeoutMs,
        })
      }
      await control.command('click', '[data-testid="settings-button"]')
      await control.command('click', '[data-testid="settings-menu-button"]')
      await control.command('waitFor', '[data-testid="general-max-concurrent-tasks-select"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('select', '[data-testid="general-max-concurrent-tasks-select"]', {
        value: '2',
      })
      assert.equal(
        await control.command('getValue', '[data-testid="general-max-concurrent-tasks-select"]'),
        '2',
        'The notification isolation scenario did not enable two concurrent tasks'
      )
      await control.command('click', '[data-testid="settings-back-button"]')

      await createSingleRootLocalProject(control, workspacePath, 'codex-notification-isolation')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await selectE2EModel(control)
      const createdProjectSnapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      const createdProjectId = createdProjectSnapshot.workbench?.currentProject?.id
      assert.ok(
        createdProjectId,
        'The notification isolation project did not become the active project'
      )
      const newConversationSelector =
        `[data-testid="project-row-${createdProjectId}"] ` +
        '[data-testid="project-new-conversation-button"]'
      await control.command('waitFor', newConversationSelector, { timeoutMs: uiTimeoutMs })
      const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      const knownRows = new Set(
        initialSnapshot.testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
      )
      const quiet = await sendTask(
        control,
        newConversationSelector,
        knownRows,
        PROMPTS.quiet,
        uiTimeoutMs
      )
      const noisy = await sendTask(
        control,
        newConversationSelector,
        knownRows,
        PROMPTS.noisy,
        uiTimeoutMs
      )
      await waitForRequestCount(requests, 2, uiTimeoutMs)

      const sidebar = `${ACTIVE_WORKSPACE_TAB_SELECTOR} [data-testid="desktop-sidebar"]`
      for (const [task, completion] of [
        [quiet, COMPLETIONS.quiet],
        [noisy, COMPLETIONS.noisy],
      ]) {
        await selectTask(control, sidebar, task, uiTimeoutMs)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: completion, timeoutMs: uiTimeoutMs }
        )
      }

      await captureScreenshot(control, 'codex-notification-isolation-complete.png', 'body')
      active = false
    },

    diagnostics() {
      return { active, emitted, requests, streamCount: streams.size }
    },
  }
}
