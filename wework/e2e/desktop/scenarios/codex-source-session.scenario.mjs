import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import { accountCommandResult } from '../modules/account-auth-command.mjs'
import {
  shellCommandPollResponse,
  shellCommandResponse,
} from '../modules/shell-command-response.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const MARKER = 'CODEX_SOURCE_SESSION'
const PROOF = 'SOURCE_SESSION_SANDBOX_OK'

// Exercise real native session/bootstrap reads before the longer stand-in flows.
export function createDesktopScenario({ workspacePath, uiTimeoutMs, modelResponseTimeoutMs }) {
  const cwd = join(workspacePath, 'source-session')
  const completed = new Set()
  return {
    async prepareApp() {
      await mkdir(cwd, { recursive: true })
      await writeFile(join(cwd, 'AGENTS.md'), 'Use the assigned workspace for this test.\n')
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input ?? [])
      const mode = ['read', 'write'].find(mode => input.includes(`${MARKER}_${mode}`))
      if (!mode) return false
      const callId = `source-session-${mode}`
      const result = accountCommandResult(body.input, callId)
      let events
      if (result?.sessionId) {
        events = shellCommandPollResponse(body, result.pollId, result.sessionId)
      } else if (result) {
        assert.ok(result.output.includes(PROOF), result.output)
        completed.add(mode)
        events = [assistantMessage(PROOF)]
      } else {
        const read = process.platform === 'win32' ? 'Get-Content AGENTS.md' : 'cat AGENTS.md'
        const write =
          process.platform === 'win32'
            ? `Set-Content -LiteralPath proof.txt -Value '${PROOF}' -NoNewline -ErrorAction Stop`
            : `printf '${PROOF}' > proof.txt`
        const echo = process.platform === 'win32' ? `Write-Output '${PROOF}'` : `printf '${PROOF}'`
        const separator = process.platform === 'win32' ? '; ' : ' && '
        const command = [read, ...(mode === 'write' ? [write] : []), echo].join(separator)
        events = shellCommandResponse(body, callId, command, cwd)
      }
      const id = `${callId}-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
      const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(model, 'The real Codex catalog must provide a default model')
      for (const mode of ['read', 'write']) {
        const taskId = `codex-source-session-${mode}`
        const origin = {
          type: mode === 'read' ? 'connection_work' : 'issue_dispatch',
          initiatedBy: 'stand_in',
          userId: 9001,
          askBeforeAct: mode === 'read',
        }
        await requestExecutor(
          control,
          'runtime.tasks.create',
          {
            taskId,
            title: `${MARKER}_${mode}`,
            runtime: 'codex',
            workspacePath: cwd,
            message: `${MARKER}_${mode}`,
            origin,
            executionRequest: {
              task_id: taskId,
              subtask_id: `${taskId}-initial`,
              user_id: 9001,
              prompt: `${MARKER}_${mode}`,
              new_session: true,
              runtime_workspace_roots: [workspacePath],
              model_config: { model_id: model.local_model_id, model_provider: model.provider },
              origin,
            },
            modelSelection: {
              modelName: model.local_model_id,
              modelType: 'runtime',
              options: { runnerModelProvider: model.provider },
            },
          },
          uiTimeoutMs
        )
        const threadId = await waitForCompletedRuntimeTaskThread(
          control,
          taskId,
          modelResponseTimeoutMs
        )
        assert.ok(threadId, `${mode} source task must create a native Codex session`)
        assert.ok(completed.has(mode), `${mode} source task must execute its sandboxed command`)
      }
      assert.equal(await readFile(join(cwd, 'proof.txt'), 'utf8'), PROOF)
    },
    diagnostics() {
      return { completed: [...completed] }
    },
  }
}
