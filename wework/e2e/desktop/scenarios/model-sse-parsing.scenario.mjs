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
import {
  assertCodeModeOutput,
  assertCodeModeRequest,
  wireDeclarations,
} from '../modules/model-wire-contract.mjs'
import { programmaticInput } from '../modules/model-tool-catalog.mjs'
import { writeSseRegressionResponse } from '../modules/sse-regression-response.mjs'
import { isCollaborationSubagentRequest } from '../modules/subagent-request.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const CASES = [
  { id: 'responses-bridge', protocol: 'responses', api: 'openai-responses' },
  { id: 'responses-native', protocol: 'responses', api: 'openai-responses', native: true },
  { id: 'chat', protocol: 'chat', api: 'openai-chat-completions' },
  { id: 'anthropic', protocol: 'anthropic', api: 'anthropic-messages' },
]

const SUBAGENT_PROMPT = 'Use a subagent for the Anthropic Messages regression.'
const SUBAGENT_TASK = 'ANTHROPIC_SUBAGENT_TASK'
const SUBAGENT_RESULT = 'ANTHROPIC_SUBAGENT_RESULT'
const SUBAGENT_DONE = 'ANTHROPIC_SUBAGENT_DONE'

function writeAnthropicSubagentTool(control, response, body, callId, name, input) {
  const tools = wireDeclarations(body, 'anthropic')
  const tool = tools.find(tool => tool.name === name || tool.name.endsWith(`__${name}`))
  if (tool) {
    control.writeAnthropicToolCall(response, input, callId, tool.name)
    return
  }
  const exec = assertCodeModeRequest(body, { protocol: 'anthropic' })
  control.writeAnthropicToolCall(
    response,
    { input: programmaticInput(name, input) },
    callId,
    exec.name
  )
}

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
  const pendingStreams = new Map()
  const subagents = { active: false, spawned: false, child: false, done: false, waits: 0 }
  return {
    codexConfigToml: '\n[features.multi_agent_v2]\nenabled = true\n',
    close() {
      for (const response of pendingStreams.values()) if (!response.destroyed) response.end()
      pendingStreams.clear()
    },
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
      if (subagents.active && model.protocol === 'anthropic') {
        if (isCollaborationSubagentRequest(request.headers)) {
          assert.ok(
            body.system?.includes(
              `Message Type: NEW_TASK\nTask name: /root/sse_worker\nSender: /root\nPayload:\n${SUBAGENT_TASK}`
            ),
            'The child task must reach the Anthropic system field'
          )
          subagents.child = true
          modelControl.writeAnthropicMessage(response, SUBAGENT_RESULT)
        } else if (!subagents.spawned) {
          assert.ok(JSON.stringify(body.messages).includes(SUBAGENT_PROMPT))
          subagents.spawned = true
          writeAnthropicSubagentTool(
            modelControl,
            response,
            body,
            'anthropic-spawn',
            'spawn_agent',
            {
              task_name: 'sse_worker',
              message: SUBAGENT_TASK,
              fork_turns: 'none',
            }
          )
        } else if (
          body.system?.includes(
            `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/sse_worker\nPayload:\n${SUBAGENT_RESULT}`
          )
        ) {
          assert.ok(subagents.child)
          subagents.done = true
          modelControl.writeAnthropicMessage(response, SUBAGENT_DONE)
        } else {
          assert.ok(
            ++subagents.waits <= 2,
            'The worker completion must reach the Anthropic system field'
          )
          writeAnthropicSubagentTool(
            modelControl,
            response,
            body,
            `anthropic-wait-${subagents.waits}`,
            'wait_agent',
            {
              timeout_ms: 60000,
            }
          )
        }
        return true
      }
      const call = toolCall(model)
      const declarations = wireDeclarations(body, model.protocol)
      const exec = declarations.filter(tool => ['exec', 'functions__exec'].includes(tool.name))
      assert.equal(exec.length, 1, 'The real Codex Code Mode entrypoint must remain available')
      if (model.protocol === 'responses')
        assert.equal(exec[0].type, model.native ? 'custom' : 'function')
      let succeeded = false
      if (observed.some(row => row.id === model.id)) {
        assertCodeModeOutput(body, model.protocol, call)
        assert.equal(
          (await readFile(join(workspacePath, call.artifact), 'utf8')).trim(),
          call.marker
        )
        succeeded = true
        const previous = pendingStreams.get(model.id)
        if (previous && !previous.destroyed) previous.end()
        pendingStreams.delete(model.id)
      }
      observed.push({ id: model.id, succeeded })
      await writeFile(join(resultDir, 'model-sse-parsing.json'), JSON.stringify(observed, null, 2))
      const endStream = model.protocol !== 'responses' || succeeded
      if (!endStream) pendingStreams.set(model.id, response)
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
        model.protocol,
        { endStream }
      )
      if (succeeded) completed.add(model.id)
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
        await waitForValue(
          () => completed.has(model.id),
          Boolean,
          `The ${model.id} tool round trip did not finish its SSE response`,
          30_000
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
      assert.equal(
        pendingStreams.size,
        0,
        'Tool results must arrive before the model closes its stream'
      )
      subagents.active = true
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: SUBAGENT_PROMPT })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        {
          text: SUBAGENT_DONE,
        }
      )
      assert.ok(subagents.done)
    },
    diagnostics() {
      return { observed, completed: [...completed], subagents }
    },
  }
}
