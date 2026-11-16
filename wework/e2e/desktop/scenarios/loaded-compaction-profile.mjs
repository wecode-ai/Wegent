import assert from 'node:assert/strict'
import { fetchLocalRuntimeJson } from '../modules/runtime-request.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const PATH = '/loaded-compaction-native/v1'
const SUMMARY = 'WEWORK_LOADED_NATIVE_COMPACTION_SUMMARY'

/** Switch a loaded API-backed thread to a native provider before compacting it. */
export function createLoadedCompactionProfileVerification({
  modelResponseTimeoutMs,
  workspacePath,
}) {
  let compactionRequest

  return {
    prepareApp({ appEnvironment, control }) {
      // Ollama uses the native provider path without requiring a real account.
      // Only its model endpoint is simulated; Electron, executor and Codex remain real.
      appEnvironment.CODEX_OSS_BASE_URL = `${control.url}${PATH}`
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || url.pathname !== `${PATH}/responses`) return false
      const body = await readRequestBody(request)
      const kind = codexRequestKind(body)
      assert.ok(['prewarm', 'compaction'].includes(kind), `Unexpected native request: ${kind}`)
      if (kind === 'compaction') compactionRequest = body
      const id = `loaded-native-compaction-${Date.now()}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(kind === 'compaction' ? SUMMARY : ''),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      const snapshot = await waitForWorkbenchDebugState(
        control,
        state => Boolean(state.pane?.currentRuntimeTask?.threadId) && !state.pane?.status?.isBusy,
        'The source thread must settle before changing its inference profile'
      )
      const { taskId, threadId } = snapshot.pane.currentRuntimeTask
      const origin = await control.command('getLocationOrigin', 'body')
      const result = await fetchLocalRuntimeJson(control, `${origin}/wework/executor/v1/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        timeoutMs: modelResponseTimeoutMs,
        body: JSON.stringify({
          id: 'loaded-native-compaction',
          method: 'runtime.tasks.compact',
          params: {
            taskId,
            workspacePath,
            modelConfig: {
              model: 'gpt-6.1-sol',
              model_id: 'gpt-6.1-sol',
              codex_model_provider: 'ollama',
              runtime_config: { codex: { use_user_config: true } },
            },
          },
        }),
      })
      assert.equal(result.ok, true, JSON.stringify(result.error))
      assert.equal(result.result.success, true, JSON.stringify(result.result))
      assert.ok(result.result.compactionItemId, 'Native compaction did not produce a history item')
      assert.ok(compactionRequest, 'Compaction retained the previous proxy provider')
      assert.equal(compactionRequest.client_metadata.thread_id, threadId)
      assert.equal(compactionRequest.model, 'gpt-6.1-sol')
    },
  }
}
