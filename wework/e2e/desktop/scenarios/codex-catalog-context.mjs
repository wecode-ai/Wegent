import assert from 'node:assert/strict'
import { rejectModelWebSocketUpgrade } from '../modules/reject-model-upgrade.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  DEFAULT_STEP_TIMEOUT_MS,
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

function catalogRestartCompleted(log) {
  const write =
    /app IPC request finished .* method=runtime\.codex\.catalog\.overrides\.(?:write|delete)[^\n]* ok=true/.exec(
      log
    )
  if (!write) return false
  const afterWrite = log.slice(write.index + write[0].length)
  for (const start of afterWrite.matchAll(
    /app IPC request started request_id=(\S+) method=runtime\.codex\.app_server\.restart/g
  )) {
    const pending = afterWrite.slice(start.index + start[0].length)
    const finishedAt = pending.indexOf(
      `app IPC request finished request_id=${start[1]} method=runtime.codex.app_server.restart `
    )
    if (finishedAt < 0) continue
    const finished = pending.slice(finishedAt).split('\n', 1)[0]
    if (!finished.endsWith(' ok=true')) continue
    const interval = pending.slice(0, finishedAt)
    const processStart = interval.indexOf('codex shared app-server process starting ')
    if (
      processStart >= 0 &&
      interval.indexOf('codex router model catalog served ', processStart) >= 0
    ) {
      return true
    }
  }
  return false
}

export async function waitForCatalogRestart(control, executorLogPath, fromOffset) {
  const startedAt = Date.now()
  let confirmed = false
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    assert.ok(!snapshot.testIds.includes('codex-catalog-error'), snapshot.text)
    const confirmation = snapshot.testIds.includes('local-model-catalog-restart-dialog')
    if (confirmation && !confirmed) {
      await control.command(
        'clickWhenEnabled',
        '[data-testid="local-model-catalog-restart-now-button"]'
      )
      confirmed = true
    }
    const log = (await readFile(executorLogPath, 'utf8')).slice(fromOffset)
    if (!confirmation && catalogRestartCompleted(log)) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The saved Catalog was not loaded by a restarted Codex app-server')
}

export function createCatalogContextVerification({
  workspacePath,
  modelId,
  modelResponseTimeoutMs,
  resultDir,
}) {
  let active = false
  let requests = 0
  let compactions = 0
  let heldResponse

  return {
    attachServer(server) {
      // The model fixture implements the HTTP Responses transport.
      server.on('upgrade', (_request, socket) => {
        rejectModelWebSocketUpgrade(server, socket)
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
      response.write(createSse(stream.start))
      if (!prewarm && heldResponse) await heldResponse.promise
      response.end(createSse(stream.finish))
      return true
    },
    async verify(control, modelLabel) {
      const edit = `[data-testid="codex-catalog-edit-openai-${modelId}"]`
      await control.command('clickWhenEnabled', edit)
      await control.command('fill', '[data-testid="local-model-context-window-input"]', {
        value: '500000',
      })
      const executorLogPath = join(resultDir, 'executor.log')
      // A customized row confirms persistence before the optional restart confirmation.
      const restartLogOffset = (await readFile(executorLogPath, 'utf8')).length
      await control.command('clickWhenEnabled', '[data-testid="codex-catalog-editor-save"]')
      await waitForCatalogRestart(control, executorLogPath, restartLogOffset)
      await control.command('waitFor', '[data-testid="codex-catalog-editor-dialog"]', {
        visible: false,
      })
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
    async verifyActiveRestartProtection(control) {
      active = true
      let release
      heldResponse = {
        promise: new Promise(resolve => {
          release = resolve
        }),
      }
      const expected = requests + 1
      try {
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
          value: `${PROMPT} active restart confirmation`,
        })
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
        await waitForWorkbenchDebugState(
          control,
          snapshot => requests === expected && snapshot.pane?.status?.isBusy === true,
          'The active Catalog confirmation fixture never entered a real model turn'
        )
        const logPath = join(resultDir, 'executor.log')
        const before =
          (await readFile(logPath, 'utf8')).match(/codex shared app-server process starting /g)
            ?.length ?? 0
        const restart = JSON.parse(
          await control.command('restartLocalCodexAppServerIfIdle', 'body')
        )
        assert.equal(
          restart.restarted,
          false,
          'An active model task was restarted without confirmation'
        )
        assert.equal(restart.requiresConfirmation, true)
        assert.ok(restart.activeTaskCount > 0, JSON.stringify(restart))
        const after =
          (await readFile(logPath, 'utf8')).match(/codex shared app-server process starting /g)
            ?.length ?? 0
        assert.equal(after, before, 'The active Codex process was replaced before confirmation')
        await writeFile(
          join(resultDir, 'codex-active-restart-protection.json'),
          JSON.stringify(
            { restart, processStartsBefore: before, processStartsAfter: after },
            null,
            2
          )
        )
        await control.command('waitFor', '[data-testid="pause-response-button"]')
      } finally {
        release()
        heldResponse = null
      }
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: `${PROMPT} complete ${expected}`,
        timeoutMs: modelResponseTimeoutMs,
      })
      await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.pane?.status?.isBusy === false,
        'The active Catalog task did not finish after declining an idle restart'
      )
      active = false
    },
  }
}
