import assert from 'node:assert/strict'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  codexRequestKind,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const PROMPT = 'WEWORK_CATALOG_CONTEXT_500K'

export function createCatalogContextVerification({
  workspacePath,
  modelId,
  modelResponseTimeoutMs,
}) {
  let active = false
  let requests = 0
  let compactions = 0

  return {
    attachServer(server) {
      // The model fixture implements the HTTP Responses transport.
      server.on('upgrade', (_request, socket) => {
        socket.end(
          'HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
        )
      })
    },
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses', '/v1/responses/compact', '/responses/compact'].includes(
          url.pathname
        )
      ) {
        return false
      }
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const kind = codexRequestKind(body)
      if (kind === 'compaction' || url.pathname.endsWith('/compact')) {
        compactions += 1
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({ error: { message: 'Unexpected Catalog context compaction' } })
        )
        return true
      }
      const prewarm = kind === 'prewarm'
      if (!prewarm) {
        assert.equal(body.model, modelId)
        assert.ok(JSON.stringify(body).includes(PROMPT), 'Catalog task lost its conversation')
        requests += 1
      }
      const stream = streamingTextEvents(
        `catalog-context-${requests}${prewarm ? '-prewarm' : ''}`,
        prewarm ? '' : `${PROMPT} complete ${requests}`,
        'final_answer'
      )
      const completed = stream.finish.find(event => event.type === 'response.completed')
      completed.response.usage = {
        input_tokens: prewarm ? 0 : 300_000,
        input_tokens_details: null,
        output_tokens: prewarm ? 0 : 20,
        output_tokens_details: null,
        total_tokens: prewarm ? 0 : 300_020,
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(createSse([...stream.start, ...stream.finish]))
      return true
    },
    async verify(control, modelLabel) {
      const edit = `[data-testid="codex-catalog-edit-openai-${modelId}"]`
      await control.command('clickWhenEnabled', edit)
      await control.command('fill', '[data-testid="local-model-context-window-input"]', {
        value: '500000',
      })
      await control.command('clickWhenEnabled', '[data-testid="codex-catalog-editor-save"]')
      await control.command(
        'waitFor',
        `[data-testid="codex-official-model-row-openai-${modelId}"]`,
        { text: '已自定义' }
      )
      await control.command('navigate', 'body', { value: '/' })
      await createSingleRootLocalProject(control, workspacePath, 'catalog-context-500k')
      await selectE2EModel(control, modelId, modelLabel, '', 'openai')
      active = true
      try {
        for (let turn = 1; turn <= 2; turn += 1) {
          await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
            value: `${PROMPT} turn ${turn}`,
          })
          await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, { enabled: true })
          await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
          await control.command('waitFor', '[data-testid="message-assistant"]', {
            text: `${PROMPT} complete ${turn}`,
            timeoutMs: modelResponseTimeoutMs,
          })
          await waitForWorkbenchDebugState(
            control,
            snapshot => snapshot.pane?.status?.isBusy === false,
            'Catalog context task did not finish'
          )
          await control.command('waitFor', '[data-testid="context-usage-indicator"]', {
            text: '475k',
          })
          assert.equal(compactions, 0, 'Catalog context was compacted at the obsolete 256k limit')
          assert.equal(requests, turn, 'The task made an unexpected model request')
        }
      } finally {
        active = false
      }
    },
  }
}
