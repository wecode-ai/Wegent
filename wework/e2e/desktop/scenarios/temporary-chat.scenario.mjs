import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ACTIVE_SURFACE = '[data-workspace-tab-content][aria-hidden="false"]'
const MAIN_COMPOSER = `${ACTIVE_SURFACE} [data-testid="desktop-empty-composer-frame"] [data-testid="chat-message-input"]`
const SIDE_CHAT = `${ACTIVE_SURFACE} [data-testid="right-workspace-chat-panel"]`
const SIDE_COMPOSER = `${SIDE_CHAT} [data-testid="chat-message-input"]`
const SOURCE_PROMPT = 'TEMPORARY_CHAT_SOURCE_CONVERSATION'
const SOURCE_COMPLETION = 'TEMPORARY_CHAT_SOURCE_COMPLETE'
const INITIAL_PROMPT = 'TEMPORARY_CHAT_INITIAL_MESSAGE'
const INITIAL_COMPLETION = 'TEMPORARY_CHAT_INITIAL_COMPLETE'
const FOLLOW_UP_PROMPT = 'TEMPORARY_CHAT_DIRECT_FOLLOW_UP'
const FOLLOW_UP_COMPLETION = 'TEMPORARY_CHAT_FOLLOW_UP_COMPLETE'

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function responseCompleted(id) {
  return {
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
  }
}

function assistantMessage(text) {
  return {
    type: 'response.output_item.done',
    item: {
      id: `wework-temporary-chat-message-${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  }
}

function streamingAssistantResponse(id, text) {
  const itemId = `${id}-message`
  return {
    start: [
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
    ],
    finish: [
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
      responseCompleted(id),
    ],
  }
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function waitForProjectWorkButton(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (
      Number(await control.command('getElementCount', '[data-testid="project-work-button"]')) > 0
    ) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The temporary-chat project selector did not become available')
}

async function waitForFolderPath(control, workspacePath, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (
      (await control.command('getValue', '[data-testid="device-folder-path-input"]')) ===
      workspacePath
    ) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The temporary-chat folder picker did not retain the workspace path')
}

async function createLocalProject(control, workspacePath, timeoutMs) {
  await waitForProjectWorkButton(control, timeoutMs)
  await control.command('click', '[data-testid="project-work-button"]')
  await control.command('click', '[data-testid="add-local-project-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', { timeoutMs })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForFolderPath(control, workspacePath, timeoutMs)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', { timeoutMs })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: 'temporary-chat',
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'temporary-chat',
    timeoutMs,
  })
}

async function waitForNewTaskRow(control, knownRows, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const taskRow = snapshot.testIds.find(
      testId => testId.startsWith('runtime-local-task-row-') && !knownRows.has(testId)
    )
    if (taskRow) return taskRow
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The temporary-chat source task row did not appear')
}

async function expandProject(control, timeoutMs) {
  const selector = `${ACTIVE_SURFACE} [data-testid="project-item-button"]`
  if ((await control.command('getAttribute', selector, { value: 'aria-expanded' })) !== 'true') {
    await control.command('click', selector)
  }
  await control.command('waitFor', `${selector}[aria-expanded="true"]`, {
    stableMs: 300,
    timeoutMs,
  })
}

async function waitForThinkingToSettle(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', SIDE_CHAT))
    if (!snapshot.testIds.includes('thinking-indicator')) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The temporary-chat response did not settle before the direct follow-up')
}

async function waitForRuntimeSource(control, taskId, timeoutMs) {
  const startedAt = Date.now()
  let lastTask = null
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    lastTask = snapshot.workbench?.currentRuntimeTask ?? null
    if (lastTask?.taskId === taskId && lastTask.hasRuntimeHandle) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(
    `The temporary-chat source did not gain a runtime handle: ${JSON.stringify(lastTask)}`
  )
}

async function waitForFollowUpRequest(getRequestCount, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (getRequestCount() > 0) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The temporary-chat direct follow-up did not reach the model server')
}

async function waitForRetainedSideThread(executorLogPath, sourceTaskId, fromOffset, timeoutMs) {
  const startedAt = Date.now()
  let sideThreadId = null
  while (Date.now() - startedAt < timeoutMs) {
    const content = await readFile(executorLogPath, 'utf8').catch(() => '')
    const recentContent = content.slice(fromOffset)
    if (sideThreadId === null) {
      const completedTurns = [
        ...recentContent.matchAll(
          /codex shared turn request finished task_id=([^\s]+)[^\n]* thread_id=([^\s]+)[^\n]* outcome=completed/g
        ),
      ]
      sideThreadId = completedTurns.find(match => match[1] !== sourceTaskId)?.[2] ?? null
    }
    if (sideThreadId !== null) {
      await new Promise(resolve => setTimeout(resolve, 500))
      const settledContent = (await readFile(executorLogPath, 'utf8').catch(() => '')).slice(
        fromOffset
      )
      assert.ok(
        !settledContent.includes(
          `codex shared thread unsubscribe background started thread_id=${sideThreadId}`
        ),
        'The active temporary-chat thread was unsubscribed before its direct follow-up'
      )
      return sideThreadId
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The temporary-chat ephemeral thread did not complete its first turn')
}

async function waitForSecondTurnOnSideThread(executorLogPath, sideThreadId, fromOffset, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const content = (await readFile(executorLogPath, 'utf8').catch(() => '')).slice(fromOffset)
    const completedTurnCount = [
      ...content.matchAll(
        new RegExp(
          `codex shared turn request finished[^\\n]* thread_id=${sideThreadId}[^\\n]* outcome=completed`,
          'g'
        )
      ),
    ].length
    assert.ok(
      !content.includes(
        `codex shared thread unsubscribe background started thread_id=${sideThreadId}`
      ),
      'The active temporary-chat thread was unsubscribed between its two turns'
    )
    if (completedTurnCount >= 2) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The temporary-chat follow-up did not complete on the retained side thread')
}

export function createDesktopScenario({
  captureScreenshot,
  resultDir,
  uiTimeoutMs,
  workspacePath,
}) {
  let active = false
  let followUpRequestCount = 0
  let releaseSource
  let releaseFollowUp
  const sourceRelease = new Promise(resolve => {
    releaseSource = resolve
  })
  const followUpRelease = new Promise(resolve => {
    releaseFollowUp = resolve
  })

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      ) {
        return false
      }

      const body = await readJson(request)
      const input = JSON.stringify(body.input ?? body.messages ?? [])
      const responseId = `wework-temporary-chat-${Date.now()}`
      const prompt = input.includes(FOLLOW_UP_PROMPT)
        ? FOLLOW_UP_PROMPT
        : input.includes(INITIAL_PROMPT)
          ? INITIAL_PROMPT
          : input.includes(SOURCE_PROMPT)
            ? SOURCE_PROMPT
            : null
      if (!prompt) return false

      const completion =
        prompt === FOLLOW_UP_PROMPT
          ? FOLLOW_UP_COMPLETION
          : prompt === INITIAL_PROMPT
            ? INITIAL_COMPLETION
            : SOURCE_COMPLETION
      if (prompt === FOLLOW_UP_PROMPT) {
        followUpRequestCount += 1
      }
      if (prompt === SOURCE_PROMPT) {
        const stream = streamingAssistantResponse(responseId, completion)
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(sse(stream.start))
        await sourceRelease
        response.end(sse(stream.finish))
        return true
      }
      if (prompt !== FOLLOW_UP_PROMPT) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(completion),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      const stream = streamingAssistantResponse(responseId, completion)
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.flushHeaders()
      response.write(sse(stream.start))
      await followUpRelease
      response.end(sse(stream.finish))
      return true
    },

    async verify(control) {
      active = true
      const taskTimeoutMs = Math.max(uiTimeoutMs, 30_000)
      await createLocalProject(control, workspacePath, uiTimeoutMs)
      await control.command('waitFor', MAIN_COMPOSER, { timeoutMs: uiTimeoutMs })

      const knownRows = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      )
      await control.command('fill', MAIN_COMPOSER, { value: SOURCE_PROMPT })
      await control.command('press', MAIN_COMPOSER, { key: 'Enter' })
      const sourceTaskRow = await waitForNewTaskRow(control, knownRows, taskTimeoutMs)
      const sourceTaskId = sourceTaskRow.replace('runtime-local-task-row-', '')
      await expandProject(control, uiTimeoutMs)
      await control.command('waitFor', `[data-testid="${sourceTaskRow}"]`, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `[data-testid="${sourceTaskRow}"]`)
      await control.command('waitFor', '[data-testid="user-message-content"]', {
        text: SOURCE_PROMPT,
        timeoutMs: taskTimeoutMs,
      })
      await waitForRuntimeSource(control, sourceTaskId, taskTimeoutMs)

      await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
      await control.command('click', '[data-testid="right-workspace-chat-option"]')
      await control.command('waitFor', SIDE_COMPOSER, { timeoutMs: uiTimeoutMs })
      const executorLogPath = join(resultDir, 'executor.log')
      const executorLogOffset = (await readFile(executorLogPath, 'utf8').catch(() => '')).length
      await control.command('fill', SIDE_COMPOSER, { value: INITIAL_PROMPT })
      await control.command('press', SIDE_COMPOSER, { key: 'Enter' })
      await control.command('waitFor', `${SIDE_CHAT} [data-testid="message-assistant"]`, {
        text: INITIAL_COMPLETION,
        timeoutMs: taskTimeoutMs,
      })
      await waitForThinkingToSettle(control, taskTimeoutMs)
      const sideThreadId = await waitForRetainedSideThread(
        executorLogPath,
        sourceTaskId,
        executorLogOffset,
        taskTimeoutMs
      )

      await expandProject(control, uiTimeoutMs)
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', MAIN_COMPOSER, { stableMs: 300, timeoutMs: uiTimeoutMs })
      await control.command('click', `[data-testid="${sourceTaskRow}"]`)
      await control.command('waitFor', `${SIDE_CHAT} [data-testid="message-assistant"]`, {
        text: INITIAL_COMPLETION,
        timeoutMs: taskTimeoutMs,
      })

      await control.command('fill', SIDE_COMPOSER, { value: FOLLOW_UP_PROMPT })
      await control.command('press', SIDE_COMPOSER, { key: 'Enter' })
      try {
        await waitForFollowUpRequest(() => followUpRequestCount, uiTimeoutMs)
        await control.command('waitFor', `${SIDE_CHAT} [data-testid="thinking-indicator"]`, {
          visible: true,
          timeoutMs: taskTimeoutMs,
        })
        const userMetrics = JSON.parse(
          await control.command(
            'getElementMetrics',
            `${SIDE_CHAT} [data-testid="user-message-content"]`
          )
        )
        const thinkingMetrics = JSON.parse(
          await control.command(
            'getElementMetrics',
            `${SIDE_CHAT} [data-testid="thinking-indicator"]`
          )
        )
        const latestUser = userMetrics.at(-1)
        const thinking = thinkingMetrics.at(-1)
        assert.ok(latestUser && thinking, 'The follow-up ordering elements were not measurable')
        assert.ok(
          latestUser.top < thinking.top,
          `The thinking indicator appeared above the direct follow-up: ${JSON.stringify({
            latestUser,
            thinking,
          })}`
        )
        await captureScreenshot(control, '01-temporary-chat-follow-up-order.png', ACTIVE_SURFACE)

        await expandProject(control, uiTimeoutMs)
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', MAIN_COMPOSER, { stableMs: 300, timeoutMs: uiTimeoutMs })
        await control.command('click', `[data-testid="${sourceTaskRow}"]`)
        await control.command('waitFor', `${SIDE_CHAT} [data-testid="user-message-content"]`, {
          text: FOLLOW_UP_PROMPT,
          timeoutMs: taskTimeoutMs,
        })

        const restoredSideChat = JSON.parse(await control.command('snapshot', SIDE_CHAT))
        assert.ok(
          restoredSideChat.text.includes(INITIAL_PROMPT),
          'Switching conversations cleared the temporary chat initial message'
        )
        assert.ok(
          restoredSideChat.text.includes(FOLLOW_UP_PROMPT),
          'Switching conversations cleared the temporary chat follow-up'
        )
        releaseFollowUp()
        await control.command('waitFor', `${SIDE_CHAT} [data-testid="message-assistant"]`, {
          text: FOLLOW_UP_COMPLETION,
          timeoutMs: taskTimeoutMs,
        })
        await waitForThinkingToSettle(control, taskTimeoutMs)
        await waitForSecondTurnOnSideThread(
          executorLogPath,
          sideThreadId,
          executorLogOffset,
          taskTimeoutMs
        )
        await captureScreenshot(control, '02-temporary-chat-two-turns.png', ACTIVE_SURFACE)
      } finally {
        releaseSource()
        releaseFollowUp()
      }
    },
  }
}
