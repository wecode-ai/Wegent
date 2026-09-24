import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const ASSISTANT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
const PROMPT = 'WEWORK_DESKTOP_E2E_CODEX_INVALID_LAUNCH_CWD'
const COMPLETION = 'WEWORK_DESKTOP_E2E_CODEX_INVALID_LAUNCH_CWD_COMPLETE'
const BUILTIN_MODEL_ID = 'gpt-5.5'
const BUILTIN_MODEL_LABEL = 'GPT 5.5'

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

function warmupResponseEvents(responseId) {
  return [
    { type: 'response.created', response: { id: responseId } },
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

async function restartExecutorAfterRemovingCwd(
  control,
  executorLogPath,
  launchWorkingDirectory,
  timeoutMs
) {
  const originalPid = await currentExecutorPid(control)
  assert.ok(originalPid, 'The initial executor process was not running')
  const logOffset = (await readFile(executorLogPath, 'utf8').catch(() => '')).length

  await rm(launchWorkingDirectory, { recursive: true })
  process.kill(originalPid, 'SIGTERM')

  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const restartedPid = await currentExecutorPid(control)
    const newLogContent = (await readFile(executorLogPath, 'utf8').catch(() => '')).slice(logOffset)
    if (
      restartedPid &&
      restartedPid !== originalPid &&
      /method=executor\.protocol\.describe.*ok=true/.test(newLogContent)
    ) {
      return restartedPid
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The executor did not become protocol-ready after the Electron cwd was removed')
}

export function createDesktopScenario({
  captureScreenshot,
  resultDir,
  uiTimeoutMs,
  workspacePath,
}) {
  let requestCount = 0
  const websocketServer = new WebSocketServer({ noServer: true })
  const executorLogPath = join(resultDir, 'executor.log')
  const launchWorkingDirectory = join(resultDir, 'invalid-launch-cwd')
  const modelServerPort = process.env.WEWORK_E2E_MODEL_SERVER_PORT
  assert.match(
    modelServerPort ?? '',
    /^\d+$/,
    'The built-in OpenAI provider scenario requires the reserved model server port'
  )
  const modelServerUrl = `http://127.0.0.1:${modelServerPort}`

  return {
    attachServer(server) {
      server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', modelServerUrl)
        if (!['/v1/responses', '/responses'].includes(url.pathname)) {
          socket.destroy()
          return
        }
        websocketServer.handleUpgrade(request, socket, head, websocket => {
          websocketServer.emit('connection', websocket, request)
        })
      })
      websocketServer.on('connection', websocket => {
        websocket.on('message', data => {
          const body = JSON.parse(data.toString())
          if (body.type !== 'response.create') return

          const responseId = `wework-invalid-cwd-${Date.now()}`
          const isWarmup = body.generate === false
          if (!isWarmup) {
            assert.match(
              JSON.stringify(body),
              new RegExp(PROMPT),
              'The built-in OpenAI request did not contain the submitted prompt'
            )
            requestCount += 1
          }
          const events = isWarmup ? warmupResponseEvents(responseId) : responseEvents(responseId)
          for (const event of events) websocket.send(JSON.stringify(event))
        })
      })
    },
    codexConfigToml: `openai_base_url = "${modelServerUrl}/v1"`,
    launchWorkingDirectory,
    modelProviderId: 'openai',
    modelId: BUILTIN_MODEL_ID,
    modelServerUrl,

    async verify(control) {
      if (process.platform !== 'win32') {
        await restartExecutorAfterRemovingCwd(
          control,
          executorLogPath,
          launchWorkingDirectory,
          uiTimeoutMs
        )
      }
      await createSingleRootLocalProject(control, workspacePath, 'codex-invalid-launch-cwd')
      await selectE2EModel(control, BUILTIN_MODEL_ID, BUILTIN_MODEL_LABEL, '', 'openai')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', ASSISTANT_SELECTOR, {
        text: COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      assert.equal(
        requestCount,
        1,
        'Codex did not complete exactly one built-in provider turn after cwd removal'
      )
      const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
      assert.equal(
        snapshot.testIds.includes('assistant-error-card'),
        false,
        'Codex rendered a configuration error for the built-in provider after its inherited cwd was removed'
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
