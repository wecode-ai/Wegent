import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  codexRequestKind,
  customToolCall,
  functionCall,
  handleEmptyReplyPrediction,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { assertCodeModeOutput, wireDeclarations } from '../modules/model-wire-contract.mjs'
import { writeSseRegressionResponse } from '../modules/sse-regression-response.mjs'

const CASES = [
  { id: 'responses-bridge', protocol: 'responses', api: 'openai-responses' },
  { id: 'responses-native', protocol: 'responses', api: 'openai-responses', native: true },
  { id: 'chat', protocol: 'chat', api: 'openai-chat-completions' },
  { id: 'anthropic', protocol: 'anthropic', api: 'anthropic-messages' },
]

function toolCall(model) {
  const artifact = `sse-regression-${model.id}.txt`
  const marker = `SSE_中文_${model.id}`
  const patch = `*** Begin Patch\n*** Add File: ${artifact}\n+${marker}\n*** End Patch`
  const cmd = process.platform === 'win32' ? `Get-Content -Raw '${artifact}'` : `cat '${artifact}'`
  return {
    artifact,
    marker,
    callId: `sse-${model.id}-exec`,
    script:
      `await tools.apply_patch(${JSON.stringify(patch)});` +
      `const result = await tools.exec_command(${JSON.stringify({ cmd, login: false })});` +
      'if (result.exit_code !== 0) throw new Error(JSON.stringify(result)); text(result.output)',
  }
}

export function createDesktopScenario({ electronUserDataDirectory, workspacePath, resultDir }) {
  let modelControl
  const observed = []
  const completed = new Set()
  return {
    async prepareApp() {
      const directory = join(electronUserDataDirectory, 'model-connections')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'model.yml'),
        JSON.stringify({
          version: 1,
          providers: CASES.map(model => ({
            id: `sse-${model.id}`,
            name: `SSE ${model.id}`,
            base_url: `http://127.0.0.1:${process.env.WEWORK_E2E_MODEL_SERVER_PORT}`,
            api_format: model.api,
            request_path: `/sse-regression/${model.id}`,
            api_key: 'sse-model-fixture-key',
            models: [
              {
                id: `sse-${model.id}`,
                model_id: `sse-${model.id}`,
                codex_catalog_model_id: 'wework-gpt-6.1-sol',
                ...(model.native
                  ? { tool_profile: 'custom', codex_tool_compatibility: 'native' }
                  : {}),
              },
            ],
          })),
        }),
        { mode: 0o600 }
      )
    },
    async handleHttp(request, response, url) {
      const model = CASES.find(model => url.pathname === `/sse-regression/${model.id}`)
      if (!model || request.method !== 'POST') return false
      const body = await readRequestBody(request)
      if (await modelControl?.writeNativeApprovalReview(response, body, model.protocol)) return true
      if (
        model.protocol !== 'responses' &&
        (isReplyPredictionRequest(body) ||
          ['compaction', 'prewarm'].includes(codexRequestKind(body)))
      ) {
        assert.ok(modelControl)
        modelControl.writeLocalAssistantMessage(
          response,
          model,
          JSON.stringify({ suggestion: null })
        )
        return true
      }
      if (handleEmptyReplyPrediction(body, response)) return true
      if (handleModelMaintenanceRequest(body, response)) return true
      assert.ok(modelControl, 'Only user-submitted regression turns may reach this oracle')
      const call = toolCall(model)
      const declarations = wireDeclarations(body, model.protocol)
      const exec = declarations.filter(tool => ['exec', 'functions__exec'].includes(tool.name))
      assert.equal(exec.length, 1, 'The real Codex Code Mode entrypoint must remain available')
      let succeeded = false
      if (observed.some(row => row.id === model.id)) {
        assertCodeModeOutput(body, model.protocol, call)
        assert.equal(
          (await readFile(join(workspacePath, call.artifact), 'utf8')).trim(),
          call.marker
        )
        completed.add(model.id)
        succeeded = true
      }
      observed.push({ id: model.id, succeeded })
      await writeFile(join(resultDir, 'model-sse-parsing.json'), JSON.stringify(observed, null, 2))
      await writeSseRegressionResponse(
        response,
        sink => {
          if (model.protocol === 'responses') {
            const events = succeeded
              ? [assistantMessage(`SSE_COMPLETED_${model.id}`)]
              : exec[0].type === 'custom'
                ? [customToolCall(call.callId, exec[0].name, call.script)]
                : functionCall(call.callId, exec[0].name, { input: call.script })
            if (exec[0].namespace)
              for (const event of events) if (event.item) event.item.namespace = exec[0].namespace
            modelControl.writeSse(sink, [
              responseCreated(`${call.callId}-${succeeded ? 'done' : 'call'}`),
              ...events,
              responseCompleted(`${call.callId}-${succeeded ? 'done' : 'call'}`),
            ])
          } else if (model.protocol === 'chat') {
            if (succeeded) modelControl.writeChatMessage(sink, `SSE_COMPLETED_${model.id}`)
            else
              modelControl.writeChatToolCall(
                sink,
                { input: call.script },
                call.callId,
                exec[0].name
              )
          } else if (succeeded)
            modelControl.writeAnthropicMessage(sink, `SSE_COMPLETED_${model.id}`)
          else
            modelControl.writeAnthropicToolCall(
              sink,
              { input: call.script },
              call.callId,
              exec[0].name
            )
        },
        model.protocol
      )
      return true
    },
    async verify(control) {
      modelControl = control
      await createSingleRootLocalProject(control, workspacePath, 'SSE parsing regression')
      for (const model of CASES) {
        await selectE2EModel(control, `local-model:sse-${model.id}`, `sse-${model.id}`)
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
          value: `SSE_REGRESSION_${model.id}`,
        })
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: `SSE_COMPLETED_${model.id}` }
        )
        assert.ok(
          completed.has(model.id),
          'Completion requires a real tool result and the on-disk artifact'
        )
      }
      assert.equal(
        observed.length,
        CASES.length * 2,
        'Each case must execute exactly one successful tool call'
      )
    },
    diagnostics() {
      return { observed, completed: [...completed] }
    },
  }
}
