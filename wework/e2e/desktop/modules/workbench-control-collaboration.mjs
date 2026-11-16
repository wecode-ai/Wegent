import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { requestExecutor, writeCodexModelConfig } from './executor-rpc.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { isCollaborationSubagentRequest } from './subagent-request.mjs'
import { DEFAULT_MODEL_ID, MODEL_PROVIDER_ID } from './shared.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectedToolCall,
  selectProgrammaticExec,
  selectTool,
  toolOutputText,
} from './response-protocol.mjs'

const MARKER = 'WEWORK_NATIVE_COLLABORATION_RECOVERY'
const CONTROLLER = `${MARKER}_CONTROLLER`
const TOOLS = [
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'send_message',
  'spawn_agent',
  'wait_agent',
]

/** Reuse the control checkpoint's real app, Executor and model endpoint. */
export function createWorkbenchControlCollaboration({
  uiTimeoutMs,
  modelResponseTimeoutMs,
  findValue,
}) {
  let active = false
  let phase = 'initial'
  let target
  let sequence = 0
  let failure
  const inventories = {}
  const spawned = new Set()
  const children = new Set()
  const completed = new Set()
  const statusCalls = {}
  const reply = (response, events) => {
    const id = `native-collaboration-${++sequence}`
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
  }
  const controllerEvents = body => {
    const callId = 'native-collaboration-continue'
    if (requestContainsToolOutput(body, callId)) {
      const result = findValue(readMcpToolOutput(body, callId), value => value.operation)
      assert.equal(result?.operation.delivery_status, 'accepted')
      return [assistantMessage(`${CONTROLLER}_DONE`)]
    }
    return mcpToolRequestEvents(body, {
      toolName: 'invoke_capability',
      directToolName: 'mcp__wework_control__invoke_capability',
      argumentsValue: {
        name: 'continue_conversation',
        arguments: {
          conversation_id: target,
          message: `${MARKER}_recovered`,
          request_key: `${MARKER}:recover-existing-disabled-thread`,
        },
      },
      searchCallId: 'native-collaboration-control-search',
      toolCallId: callId,
    }).events
  }
  const parentEvents = body => {
    const callId = `native-collaboration-inventory-${phase}`
    const inventory = toolOutputText(body, callId)
    if (!inventory && !inventories[phase]) {
      const code = `text(ALL_TOOLS.filter(t => t.name.startsWith('collaboration__')).map(t => t.name.slice('collaboration__'.length)).sort())`
      return selectedToolCall(callId, { codeMode: selectProgrammaticExec(body, code) })
    }
    if (inventory) inventories[phase] = JSON.parse(inventory)
    assert.deepEqual(inventories[phase], phase === 'disabled' ? [] : TOOLS)
    const childResult = `${MARKER}_CHILD_${phase}_DONE`
    if (phase === 'disabled') {
      completed.add(phase)
      return [assistantMessage(`${MARKER}_${phase}_DONE`)]
    }
    if (!spawned.has(phase)) {
      spawned.add(phase)
      return selectedToolCall(
        `native-collaboration-spawn-${phase}`,
        selectTool(body, 'spawn_agent', {
          task_name: `control_resume_${phase}`,
          message: childResult,
        })
      )
    }
    const status = statusCalls[phase] && toolOutputText(body, statusCalls[phase])
    if (status) {
      const child = JSON.parse(status).agents.find(
        agent => agent.agent_name === `/root/control_resume_${phase}`
      )
      if (child?.agent_status && Object.hasOwn(child.agent_status, 'completed')) {
        assert.ok(children.has(phase), 'A real child must finish first')
        assert.equal(child.agent_status.completed?.trim(), childResult)
        completed.add(phase)
        return [assistantMessage(`${MARKER}_${phase}_DONE`)]
      }
      delete statusCalls[phase]
      return selectedToolCall(
        `native-collaboration-wait-${sequence}`,
        selectTool(body, 'wait_agent', { timeout_ms: 10000 })
      )
    }
    statusCalls[phase] = `native-collaboration-status-${sequence}`
    return selectedToolCall(
      statusCalls[phase],
      selectTool(body, 'list_agents', { path_prefix: `/root/control_resume_${phase}` })
    )
  }
  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      try {
        const body = await readRequestBody(request)
        if (handleEmptyReplyPrediction(body, response)) return true
        assert.ok(
          JSON.stringify(body.input).includes(MARKER),
          'Unexpected model work during native collaboration recovery'
        )
        if (isCollaborationSubagentRequest(request.headers)) {
          children.add(phase)
          reply(response, [assistantMessage(`${MARKER}_CHILD_${phase}_DONE`)])
        } else
          reply(
            response,
            JSON.stringify(body.input).includes(CONTROLLER)
              ? controllerEvents(body)
              : parentEvents(body)
          )
      } catch (error) {
        failure = error
        response.writeHead(500)
        response.end('Native collaboration recovery failed')
      }
      return true
    },
    async verify(control, workspacePath) {
      active = true
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await writeCodexModelConfig(
        control,
        { provider: MODEL_PROVIDER_ID, model: DEFAULT_MODEL_ID },
        uiTimeoutMs
      )
      await waitForValue(
        () => rpc('runtime.codex.app_server.restart', { ifIdle: true }),
        value => value.restarted === true,
        'Native collaboration could not reload the local E2E model provider',
        uiTimeoutMs
      )
      const models = (await rpc('runtime.runner.catalog', {})).models
      const model = models.find(
        model =>
          model.runtime === 'codex' && model.provider === MODEL_PROVIDER_ID && model.is_default
      )
      assert.ok(
        model,
        `Native collaboration requires the local Codex model: ${JSON.stringify(models)}`
      )
      assert.equal(
        model.local_model_id,
        DEFAULT_MODEL_ID,
        'Native collaboration did not load the configured E2E model'
      )
      const taskId = `native-collaboration-${randomUUID()}`
      const execution = {
        task_id: taskId,
        subtask_id: `${taskId}-initial`,
        user_id: 9001,
        prompt: `${MARKER}_initial`,
        new_session: true,
        bot: [{ shell_type: 'Codex' }],
        collaborationMode: 'default',
        model_config: {
          model_id: model.local_model_id,
          model_provider: model.provider,
          runtime_config: { codex: { use_user_config: true, configured: true } },
        },
      }
      const selection = {
        modelName: model.local_model_id,
        modelType: 'runtime',
        options: {
          collaborationMode: 'default',
          runnerModelProvider: MODEL_PROVIDER_ID,
        },
      }
      const waitDone = id =>
        waitForValue(
          async () => {
            if (failure) throw failure
            const value = (await rpc('runtime.tasks.get', { taskId: id })).task
            assert.notEqual(value.status, 'failed', JSON.stringify(value))
            return value
          },
          value => value.running === false && value.status === 'done',
          'Native collaboration did not complete',
          modelResponseTimeoutMs
        )
      try {
        const created = await rpc('runtime.tasks.create', {
          taskId,
          title: MARKER,
          runtime: 'codex',
          workspacePath,
          message: execution.prompt,
          executionRequest: execution,
          modelSelection: selection,
        })
        assert.equal(created.accepted, true, created.error)
        target = `conv_${Buffer.from(JSON.stringify([created.deviceId, taskId])).toString('base64url')}`
        const original = await waitDone(taskId)
        assert.ok(completed.has('initial'))
        phase = 'disabled'
        // Exercise the real single-agent path to reproduce the saved disabled family.
        const single = { ...execution, subtask_id: `${taskId}-disabled`, new_session: false }
        delete single.collaborationMode
        single.collaboration_model = 'single'
        const disabled = await rpc('runtime.tasks.send', {
          taskId,
          message: `${MARKER}_disabled`,
          executionRequest: single,
          collaboration_model: 'single',
          modelSelection: selection,
        })
        assert.equal(disabled.accepted, true, disabled.error)
        assert.equal((await waitDone(taskId)).threadId, original.threadId)
        assert.ok(completed.has('disabled'))
        await waitForValue(
          () => rpc('runtime.codex.app_server.restart', { ifIdle: true }),
          value => value.restarted === true,
          'Native collaboration did not become idle for cold resume',
          uiTimeoutMs
        )
        phase = 'recovered'
        const controllerId = `native-collaboration-controller-${randomUUID()}`
        const controller = await rpc('runtime.tasks.create', {
          taskId: controllerId,
          runtime: 'codex',
          workspacePath,
          title: CONTROLLER,
          message: CONTROLLER,
          modelSelection: selection,
          executionRequest: {
            ...execution,
            task_id: controllerId,
            subtask_id: `${controllerId}-initial`,
            prompt: CONTROLLER,
          },
        })
        assert.equal(controller.accepted, true, controller.error)
        await waitDone(controllerId)
        assert.equal(
          (await waitDone(taskId)).threadId,
          original.threadId,
          'Control must continue the original thread'
        )
        assert.ok(completed.has('recovered'))
        assert.deepEqual([...spawned].sort(), ['initial', 'recovered'])
        const transcript = await rpc('runtime.tasks.transcript', { taskId, limit: 100 })
        assert.ok(JSON.stringify(transcript).includes(`${MARKER}_recovered_DONE`))
      } finally {
        active = false
      }
    },
    diagnostics: () => ({
      active,
      phase,
      inventories,
      spawned: [...spawned],
      children: [...children],
      completed: [...completed],
      failure: failure?.message,
    }),
  }
}
