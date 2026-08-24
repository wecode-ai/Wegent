import assert from 'node:assert/strict'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createSingleRootLocalProject } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const FIRST_PROMPT = 'WEWORK_DESKTOP_E2E_TERMINAL_CONVERGENCE_FIRST'
const FIRST_COMPLETION = 'WEWORK_DESKTOP_E2E_TERMINAL_CONVERGENCE_FIRST_COMPLETE'
const FOLLOW_UP_PROMPT = 'WEWORK_DESKTOP_E2E_TERMINAL_CONVERGENCE_FOLLOW_UP'
const FOLLOW_UP_COMPLETION = 'WEWORK_DESKTOP_E2E_TERMINAL_CONVERGENCE_FOLLOW_UP_COMPLETE'

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function assistantMessage(id, text) {
  return {
    type: 'response.output_item.done',
    item: {
      id: `${id}-message`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  }
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

async function waitForCondition(predicate, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

async function waitForNewTaskRow(control, knownRows, timeoutMs) {
  return waitForCondition(
    async () => {
      const snapshot = JSON.parse(await control.command('snapshot', 'body'))
      return snapshot.testIds.find(
        testId => testId.startsWith('runtime-local-task-row-') && !knownRows.has(testId)
      )
    },
    timeoutMs,
    'The terminal convergence task row was not created'
  )
}

async function clearExecutionLease(executorHome, taskId, timeoutMs) {
  const statePath = join(executorHome, 'runtime-work', 'worktrees.json')
  await waitForCondition(
    async () => {
      try {
        const state = JSON.parse(await readFile(statePath, 'utf8'))
        const record = Object.values(state.records ?? {}).find(
          candidate => candidate.worktreeId === taskId
        )
        if (!record?.executionLease) return false
        record.executionLease = null
        const nextPath = `${statePath}.terminal-convergence`
        await writeFile(nextPath, `${JSON.stringify(state)}\n`, 'utf8')
        await rename(nextPath, statePath)
        return true
      } catch (error) {
        if (error?.code === 'ENOENT') return false
        throw error
      }
    },
    timeoutMs,
    'The running Worktree never published an execution lease'
  )
}

export function createDesktopScenario({
  captureScreenshot,
  executorHome,
  uiTimeoutMs,
  workspacePath,
}) {
  let active = false
  let firstRequestResolve
  let releaseFirstResponseResolve
  let followUpRequestResolve
  const firstRequest = new Promise(resolve => {
    firstRequestResolve = resolve
  })
  const releaseFirstResponse = new Promise(resolve => {
    releaseFirstResponseResolve = resolve
  })
  const followUpRequest = new Promise(resolve => {
    followUpRequestResolve = resolve
  })

  return {
    async handleHttp(request, response, url) {
      if (!active || request.method !== 'POST') return false
      if (!['/v1/responses', '/responses'].includes(url.pathname)) return false

      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      const responseId = `wework-terminal-convergence-${Date.now()}`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })

      if (body.includes(FOLLOW_UP_PROMPT)) {
        followUpRequestResolve()
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(responseId, FOLLOW_UP_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      assert.ok(
        body.includes(FIRST_PROMPT),
        'The terminal convergence scenario received an unexpected model request'
      )
      response.flushHeaders()
      response.write(sse([responseCreated(responseId)]))
      firstRequestResolve()
      await releaseFirstResponse
      response.end(
        sse([assistantMessage(responseId, FIRST_COMPLETION), responseCompleted(responseId)])
      )
      return true
    },

    async verify(control) {
      active = true
      await createSingleRootLocalProject(control, workspacePath, 'runtime-terminal-convergence')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      const knownRows = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      )

      await control.command('click', '[data-testid="execution-mode-button"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="execution-mode-git-worktree-button"]'
      )
      await control.command('fill', COMPOSER_SELECTOR, { value: FIRST_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      const taskRowTestId = await waitForNewTaskRow(control, knownRows, uiTimeoutMs)
      const taskId = taskRowTestId.replace('runtime-local-task-row-', '')
      await Promise.race([
        firstRequest,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The terminal convergence request did not reach Codex')),
            uiTimeoutMs
          )
        ),
      ])
      await control.command('waitFor', `[data-testid="runtime-local-task-running-${taskId}"]`, {
        timeoutMs: uiTimeoutMs,
      })

      await clearExecutionLease(executorHome, taskId, uiTimeoutMs)
      releaseFirstResponseResolve()
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FIRST_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await waitForCondition(
        async () => {
          const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
          return (
            !snapshot.testIds.includes('pause-response-button') &&
            !snapshot.testIds.includes('thinking-indicator') &&
            !snapshot.testIds.includes(`runtime-local-task-running-${taskId}`)
          )
        },
        uiTimeoutMs,
        'Codex completed, but the local task remained in the running state'
      )

      await control.command('fill', COMPOSER_SELECTOR, { value: FOLLOW_UP_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await Promise.race([
        followUpRequest,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The follow-up was queued after Codex had completed')),
            uiTimeoutMs
          )
        ),
      ])
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FOLLOW_UP_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const settledSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.equal(
        settledSnapshot.testIds.includes('conversation-queue-panel'),
        false,
        'The follow-up remained in the queue after terminal state convergence'
      )
      assert.equal(
        settledSnapshot.testIds.includes('chat-input-error'),
        false,
        'The terminal state convergence path returned a send error to the user'
      )
      await captureScreenshot(
        control,
        'runtime-terminal-convergence-01-follow-up-sent.png',
        ACTIVE_WORKBENCH_SELECTOR
      )
      active = false
    },

    diagnostics() {
      return { active }
    },
  }
}
