import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const CATALOG = 'wework-gpt-6.1-sol'
const KEY = 'catalog-auto-compaction-fixture-key'
const PREFIX = 'WEWORK_CATALOG_AUTO_COMPACTION'
const INDICATOR = '[data-testid="context-usage-indicator"]'
const COMPACTION = '[data-testid="context-compaction-indicator"]'
const CASES = [
  { id: 'chat-default', protocol: 'openai-chat-completions', output: 96_000 },
  { id: 'messages-default', protocol: 'anthropic-messages', output: 96_000 },
  {
    id: 'chat-kimi-catalog',
    protocol: 'openai-chat-completions',
    model: 'kimi-k3.1-pro',
    window: 1_048_576,
    output: 96_000,
  },
  {
    id: 'chat-explicit-output',
    protocol: 'openai-chat-completions',
    maxOutputTokens: 32_000,
    output: 32_000,
  },
  {
    id: 'messages-explicit-output',
    protocol: 'anthropic-messages',
    contextWindow: 320_000,
    maxOutputTokens: 16_000,
    output: 16_000,
  },
  {
    id: 'responses-explicit-output',
    protocol: 'openai-responses',
    contextWindow: 400_000,
    maxOutputTokens: 64_000,
    output: 64_000,
  },
  { id: 'responses-provider-default', protocol: 'openai-responses', output: null },
]

function writeModelResponse(response, protocol, text, inputTokens) {
  const id = `catalog-auto-${Date.now()}`
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
  if (protocol === 'openai-responses') {
    const completed = responseCompleted(id)
    Object.assign(completed.response.usage, {
      input_tokens: inputTokens,
      total_tokens: inputTokens,
    })
    response.end(createSse([responseCreated(id), assistantMessage(text), completed]))
  } else if (protocol === 'openai-chat-completions') {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: inputTokens, completion_tokens: 0, total_tokens: inputTokens },
    }
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
  } else {
    response.end(
      createSse([
        {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'gpt-6.1-sol',
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 },
        },
        { type: 'message_stop' },
      ])
    )
  }
}

export function createCatalogAutoCompactionVerification({
  electronUserDataDirectory,
  workspacePath,
  modelResponseTimeoutMs,
  captureScreenshot,
}) {
  let current
  let lastCase
  const results = []

  async function send(control, turn) {
    const { fixture } = current
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
      value: `${PREFIX}:${fixture.id}:turn:${turn}`,
    })
    await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: `${PREFIX}:${fixture.id}:answer:${turn}`,
      timeoutMs: modelResponseTimeoutMs,
    })
    return waitForWorkbenchDebugState(
      control,
      snapshot => snapshot.pane?.status?.isBusy === false,
      `${fixture.id} turn ${turn} did not settle`
    )
  }

  return {
    async prepareApp({ control }) {
      const directory = join(electronUserDataDirectory, 'model-connections')
      await mkdir(directory, { recursive: true })
      // Seed the real configuration file before Electron starts. The host, renderer,
      // executor, Codex and protocol conversion all use their production paths.
      await writeFile(
        join(directory, 'model.yml'),
        JSON.stringify({
          version: 1,
          providers: [
            {
              id: 'catalog-auto-compaction',
              name: 'Catalog auto compaction',
              base_url: control.url,
              api_format: 'openai-responses',
              api_key: KEY,
              models: CASES.map(fixture => ({
                id: fixture.id,
                model_id: fixture.model ?? 'gpt-6.1-sol',
                display_name: fixture.id,
                provider_profile_id: 'deepseek',
                api_format: fixture.protocol,
                request_path: `/catalog-auto/${fixture.id}/v1/${
                  fixture.protocol === 'openai-chat-completions'
                    ? 'chat/completions'
                    : fixture.protocol === 'anthropic-messages'
                      ? 'messages'
                      : 'responses'
                }`,
                ...(fixture.model ? {} : { codex_catalog_model_id: CATALOG }),
                ...(fixture.contextWindow ? { context_window: fixture.contextWindow } : {}),
                ...(fixture.maxOutputTokens ? { max_output_tokens: fixture.maxOutputTokens } : {}),
              })),
            },
          ],
        })
      )
    },

    async handleHttp(request, response, url) {
      const fixture = CASES.find(fixture => url.pathname.startsWith(`/catalog-auto/${fixture.id}/`))
      if (!fixture || request.method !== 'POST') return false
      const body = await readRequestBody(request)
      assert.equal(body.model, fixture.model ?? 'gpt-6.1-sol', 'The upstream model changed')
      const serialized = JSON.stringify(body)
      const metadata = JSON.parse(
        body.client_metadata?.['x-codex-turn-metadata'] ??
          request.headers['x-codex-turn-metadata'] ??
          '{}'
      )
      const kind = codexRequestKind(body) ?? metadata.request_kind
      current?.requestTrace.push({ kind, source: metadata.thread_source })
      const prediction =
        metadata.thread_source === 'composer_predictions' || isReplyPredictionRequest(body)
      if (prediction || kind === 'prewarm') {
        const text =
          kind === 'compaction'
            ? `${PREFIX}:${fixture.id}:prediction-summary`
            : prediction
              ? '{"suggestion":null}'
              : ''
        writeModelResponse(response, fixture.protocol, text, 0)
        return true
      }
      assert.equal(current?.fixture.id, fixture.id, 'A settled case made another model request')
      assert.equal(request.headers.authorization, `Bearer ${KEY}`)
      if (fixture.protocol === 'anthropic-messages') assert.equal(request.headers['x-api-key'], KEY)
      assert.equal(
        body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? null,
        fixture.output,
        'The request output ceiling disagrees with the compaction reservation'
      )
      if (kind === 'compaction') {
        current.compactions += 1
        assert.equal(current.requests, 2, 'Compaction ran before the configured 80% threshold')
        assert.equal(current.compactions, 1, 'Automatic compaction repeated')
        assert.ok(serialized.includes(`${PREFIX}:${fixture.id}:turn:1`))
        writeModelResponse(response, fixture.protocol, current.summary, 1200)
      } else {
        current.requests += 1
        const turn = current.requests
        assert.ok(serialized.includes(`${PREFIX}:${fixture.id}:turn:${turn}`))
        if (turn >= 3) {
          assert.ok(serialized.includes(current.summary), 'Continuation lost the compacted summary')
          current.continuations += 1
        }
        writeModelResponse(
          response,
          fixture.protocol,
          `${PREFIX}:${fixture.id}:answer:${turn}`,
          turn === 1 ? current.below : turn === 2 ? current.above : 1400
        )
      }
      return true
    },

    async verify(control) {
      await control.command('navigate', 'body', { value: '/' })
      await createSingleRootLocalProject(control, workspacePath, 'catalog-auto-compaction')
      const project = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        .workbench.currentProject
      try {
        for (const fixture of CASES) {
          const window = fixture.contextWindow ?? fixture.window ?? 272_000
          const inputBudget = window - (fixture.output ?? 0)
          const limit = Math.floor(inputBudget * 0.8)
          current = {
            fixture,
            summary: `${PREFIX}:${fixture.id}:summary`,
            below: fixture.output === null ? 230_000 : limit - 1024,
            above: fixture.output === null ? 260_000 : limit + 1024,
            requests: 0,
            compactions: 0,
            continuations: 0,
            requestTrace: [],
          }
          await control.command(
            'click',
            `[data-testid="project-row-${project.id}"] [data-testid="project-new-conversation-button"]`
          )
          await selectE2EModel(control, `local-model:${fixture.id}`, fixture.id)
          await send(control, 1)
          const denominator = Math.min(Math.floor(window * 0.95), inputBudget)
          const percent = Math.round((current.below / denominator) * 100)
          const label = await control.command('getAttribute', INDICATOR, { value: 'aria-label' })
          assert.ok(label.includes(`${percent}%`), `${fixture.id}: unexpected usage: ${label}`)
          assert.equal(current.compactions, 0)
          await control.command('press', '[data-testid="context-usage-button"]', { key: 'Escape' })
          await control.command('waitFor', '[data-testid="context-usage-compact-hint"]', {
            visible: true,
          })
          const before = await send(control, 2)
          assert.equal(current.compactions, 0, 'The below-threshold turn auto-compacted')
          const after = await send(control, 3)
          const identity = snapshot => {
            const { deviceId, taskId, threadId } = snapshot.workbench.currentRuntimeTask
            assert.ok(threadId, 'The conversation has no Codex thread identity')
            return { deviceId, taskId, threadId }
          }
          assert.deepEqual(identity(after), identity(before))
          assert.equal(current.compactions, 1, 'The above-threshold turn did not auto-compact')
          const messageId = await control.command(
            'getAttribute',
            '[data-testid="message-assistant"]',
            {
              text: `${PREFIX}:${fixture.id}:answer:3`,
              value: 'data-message-id',
            }
          )
          assert.ok(messageId, 'The compacted turn did not expose its assistant message')
          const message = `[data-message-id=${JSON.stringify(messageId)}]`
          const collapsed = `${message} [data-testid="final-processing-toggle"][aria-expanded="false"]`
          if (Number(await control.command('getElementCount', collapsed)) > 0) {
            await control.command('click', collapsed)
          }
          await control.command('waitFor', `${message} ${COMPACTION}`, { text: '上下文已自动压缩' })
          assert.deepEqual(identity(await send(control, 4)), identity(before))
          assert.equal(current.compactions, 1)
          assert.equal(current.continuations, 2)
          results.push({ id: fixture.id, inputBudget, ...current, fixture: undefined })
          console.log(`[desktop-e2e] Catalog auto compaction passed: ${fixture.id}`)
        }
        await captureScreenshot(control, 'context-compaction-07-catalog-auto.png', 'body')
      } finally {
        lastCase = current
        current = null
      }
    },
    diagnostics: () => ({ current: current ?? lastCase, results }),
  }
}
