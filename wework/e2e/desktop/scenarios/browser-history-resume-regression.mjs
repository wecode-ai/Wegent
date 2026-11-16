import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const PROMPT = 'WEWORK_BROWSER_COLD_HISTORY_RESUME'

export async function handleBrowserHistoryModelRequest(request, response, url) {
  if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
    return false
  const body = await readRequestBody(request)
  if (!JSON.stringify(body).includes(PROMPT)) return false
  if (handleEmptyReplyPrediction(body, response)) return true
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    createSse([responseCreated(PROMPT), assistantMessage(PROMPT), responseCompleted(PROMPT)])
  )
  return true
}

export async function verifyBrowserHistoryResume(control, resultDir, workspacePath, timeoutMs) {
  const rpc = (method, params) => requestExecutor(control, method, params, timeoutMs)
  const catalog = await rpc('runtime.runner.catalog', {})
  const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
  assert.ok(model, 'The local browser owner needs a configured real Codex model')
  const taskId = 'browser-cold-history-' + randomUUID()
  // Cloud checkpoints select a remote execution device. Create this browser
  // fixture on the local owner whose app-server and bridge are being verified.
  const created = await rpc('runtime.tasks.create', {
    taskId,
    title: PROMPT,
    runtime: 'codex',
    workspacePath,
    message: PROMPT,
    executionRequest: {
      task_id: taskId,
      subtask_id: taskId + '-initial',
      user_id: 9001,
      prompt: PROMPT,
      new_session: true,
      bot: [{ shell_type: 'Codex', name: 'Browser cold history regression' }],
      model_config: {
        model_id: model.local_model_id,
        model_provider: model.provider,
        runtime_config: { codex: { use_user_config: true, configured: true } },
      },
    },
  })
  assert.equal(created.accepted, true)
  const address = { deviceId: created.deviceId, taskId, workspacePath }
  const threadId = await waitForCompletedRuntimeTaskThread(control, taskId, timeoutMs)
  // A completed task can still have UI history reads in flight. A declined
  // idle restart has no side effects; wait for the owner to admit the restart.
  await waitForValue(
    () => rpc('runtime.codex.app_server.restart', { ifIdle: true }),
    result => result.restarted === true,
    'Cold history recovery requires the old MCP pool to stop after pending reads settle',
    timeoutMs
  )

  // No new user turn runs between restart and history refresh. Native startup
  // must connect the task's MCP servers here, before any Goal can continue.
  await rpc('runtime.tasks.transcript', { address, refresh: true })
  await waitForValue(
    async () => {
      const log = await readFile(join(resultDir, 'executor.log'), 'utf8')
      const startup = log.lastIndexOf('codex shared app-server process initialized')
      assert.ok(startup >= 0, 'The restarted real Codex app-server must initialize')
      const current = log.slice(startup).split('\n')
      return ['wework_browser', 'wework_space'].filter(server =>
        current.some(
          line =>
            line.includes('codex MCP startup status') &&
            line.includes(`thread_id=${threadId} `) &&
            line.includes(`server_name=${server} status=ready`)
        )
      )
    },
    ready => ready.length === 2,
    'Cold history resume must connect browser and project tools without another model turn',
    timeoutMs
  )
}
