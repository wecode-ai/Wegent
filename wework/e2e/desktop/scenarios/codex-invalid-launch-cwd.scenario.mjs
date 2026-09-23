import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const ASSISTANT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
const PROMPT = 'WEWORK_DESKTOP_E2E_CODEX_INVALID_LAUNCH_CWD'
const COMPLETION = 'WEWORK_DESKTOP_E2E_CODEX_INVALID_LAUNCH_CWD_COMPLETE'

function sse(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function responseEvents(responseId) {
  const itemId = `${responseId}-message`
  return [
    { type: 'response.created', response: { id: responseId } },
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
    {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: COMPLETION,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: COMPLETION, annotations: [] }],
        phase: 'final_answer',
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
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

async function currentExecutorPid(control) {
  const diagnostics = JSON.parse(await control.command('getDesktopRuntimeDiagnostics', 'body'))
  const pid = Number(diagnostics.executorPid)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

async function restartExecutorAfterRemovingCwd(control, launchWorkingDirectory, timeoutMs) {
  const originalPid = await currentExecutorPid(control)
  assert.ok(originalPid, 'The initial executor process was not running')

  await rm(launchWorkingDirectory, { recursive: true })
  process.kill(originalPid, 'SIGTERM')

  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const restartedPid = await currentExecutorPid(control)
    if (restartedPid && restartedPid !== originalPid) return restartedPid
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The executor did not restart after the Electron cwd was removed')
}

export function createDesktopScenario({
  captureScreenshot,
  resultDir,
  uiTimeoutMs,
  workspacePath,
}) {
  let requestCount = 0
  const launchWorkingDirectory = join(resultDir, 'invalid-launch-cwd')

  return {
    launchWorkingDirectory,

    async handleHttp(request, response, url) {
      if (request.method !== 'POST') return false
      if (!['/v1/responses', '/responses'].includes(url.pathname)) return false

      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      if (!body.includes(PROMPT)) return false

      requestCount += 1
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.end(responseEvents(`wework-invalid-cwd-${Date.now()}`).map(sse).join(''))
      return true
    },

    async verify(control) {
      if (process.platform !== 'win32') {
        await restartExecutorAfterRemovingCwd(control, launchWorkingDirectory, uiTimeoutMs)
      }
      await createSingleRootLocalProject(control, workspacePath, 'codex-invalid-launch-cwd')
      await selectE2EModel(control)
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', ASSISTANT_SELECTOR, {
        text: COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      assert.equal(requestCount, 1, 'Codex did not complete exactly one turn after cwd removal')
      const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
      assert.equal(
        snapshot.testIds.includes('assistant-error-card'),
        false,
        'Codex rendered a configuration error after its inherited cwd was removed'
      )
      await captureScreenshot(
        control,
        'codex-invalid-launch-cwd-01-completed.png',
        ACTIVE_WORKBENCH_SELECTOR
      )
    },

    diagnostics() {
      return { requestCount }
    },
  }
}
