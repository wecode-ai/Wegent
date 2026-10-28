import assert from 'node:assert/strict'

import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { selectE2EModel } from '../modules/shared.mjs'

const WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER = `${WORKBENCH} [data-testid="chat-message-input"][contenteditable="true"]`
const PR = 'https://github.com/synthetic/control-e2e/pull/43'
const SOURCE = `WEWORK_CONTROL_SOURCE_E2E: this conversation owns ${PR}`
const CONTROLLER = 'WEWORK_CONTROL_CONTROLLER_E2E'
const CREATED = 'WEWORK_CONTROL_CREATED_E2E'
const FOLLOW_UP =
  'WEWORK_CONTROL_CI_FAILED_E2E: PR checks failed; handle this in the original conversation.'

function findValue(value, predicate) {
  if (typeof value === 'string') {
    try {
      return findValue(JSON.parse(value), predicate)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  if (predicate(value)) return value
  for (const child of Object.values(value)) {
    const match = findValue(child, predicate)
    if (match) return match
  }
  return undefined
}

function callResult(body, callId) {
  const output = findValue(
    body.input,
    value => value.call_id === callId && value.type?.endsWith('_call_output')
  )
  assert.ok(output, `Missing real MCP output for ${callId}`)
  const error = findValue(output.output, value => value.isError === true)
  assert.equal(error, undefined, `Control MCP failed: ${JSON.stringify(output.output)}`)
  return output.output
}

export function createDesktopScenario({ uiTimeoutMs }) {
  let active = false
  let sourceId
  let sourceTaskId
  let operationId
  let automationId
  let createdId
  let createdTaskId
  let stage = 0
  let followUpRequests = 0
  let failure
  const observed = []
  const steps = [
    [
      'get_current_context',
      () => ({}),
      value =>
        assert.ok(
          findValue(value, item => item.conversation_id && item.conversation_id !== sourceId)
        ),
    ],
    [
      'list_conversations',
      () => ({ limit: 100 }),
      value => assert.ok(findValue(value, item => item.conversation_id === sourceId)),
    ],
    [
      'read_conversation',
      () => ({ conversation_id: sourceId }),
      value => assert.ok(JSON.stringify(value).includes(SOURCE)),
    ],
    ['bind_change_request', () => ({ conversation_id: sourceId, url: PR })],
    [
      'find_conversations_by_change_request',
      () => ({ url: PR }),
      value => assert.ok(findValue(value, item => item.resolution === 'unique')),
    ],
    [
      'continue_conversation',
      () => ({
        conversation_id: sourceId,
        message: FOLLOW_UP,
        request_key: 'ci:synthetic/control-e2e:43:head:run:1',
      }),
      value => {
        const receipt = findValue(value, item => item.operation && item.duplicate === false)
        assert.equal(receipt?.operation.delivery_status, 'accepted')
        operationId = receipt.operation.operation_id
      },
    ],
    [
      'continue_conversation',
      () => ({
        conversation_id: sourceId,
        message: FOLLOW_UP,
        request_key: 'ci:synthetic/control-e2e:43:head:run:1',
      }),
      value => assert.ok(findValue(value, item => item.duplicate === true)),
    ],
    [
      'get_operation',
      () => ({ operation_id: operationId }),
      value => assert.ok(findValue(value, item => item.operation_id === operationId)),
    ],
    [
      'create_automation',
      () => ({
        name: 'Control CI every five minutes',
        prompt:
          'Check CI, resolve the confirmed PR conversation and continue it with a stable CI request key.',
        schedule: { type: 'interval', value: 5, unit: 'minutes' },
        timezone: 'Asia/Shanghai',
        enabled: false,
      }),
      value => {
        const automation = findValue(
          value,
          item => item.name === 'Control CI every five minutes' && item.id
        )
        assert.ok(automation)
        assert.equal(automation.enabled, false)
        assert.equal(automation.taskPayload, undefined)
        automationId = automation.id
      },
    ],
    [
      'get_automation',
      () => ({ automation_id: automationId }),
      value => assert.ok(findValue(value, item => item.id === automationId)),
    ],
    ['delete_automation', () => ({ automation_id: automationId })],
    [
      'get_conversation_creation_options',
      () => ({}),
      value =>
        assert.ok(findValue(value, item => item.properties?.options?.properties?.initialGoal)),
    ],
    [
      'create_conversation',
      () => ({
        message: CREATED,
        title: 'MCP configured conversation',
        options: {
          modelOptions: {
            reasoningEffort: 'high',
            permissionMode: 'read-only',
            collaborationMode: 'plan',
          },
        },
      }),
      value => {
        const created = findValue(value, item => item.accepted === true && item.conversation_id)
        assert.ok(created)
        assert.equal(created.runtimeHandle, undefined)
        createdId = created.conversation_id
        createdTaskId = created.taskId
      },
    ],
    [
      'get_conversation',
      () => ({ conversation_id: createdId }),
      value => {
        const conversation = findValue(value, item => item.conversation_id === createdId)
        assert.equal(conversation?.model_selection.options.reasoning, 'high')
        assert.equal(conversation?.model_selection.options.permissionMode, 'read-only')
        assert.equal(conversation?.model_selection.options.collaborationMode, 'plan')
      },
    ],
  ]

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
        const serialized = JSON.stringify(body)
        const id = `wework-control-${Date.now()}`
        let events
        if (serialized.includes(CONTROLLER)) {
          const callId = `control-step-${stage}`
          if (stage < steps.length && requestContainsToolOutput(body, callId)) {
            const value = callResult(body, callId)
            steps[stage][2]?.(value)
            observed.push(steps[stage][0])
            stage += 1
          }
          events =
            stage === steps.length
              ? [assistantMessage('WEWORK_CONTROL_COMPLETE'), responseCompleted(id)]
              : [
                  ...mcpToolRequestEvents(body, {
                    toolName: 'invoke_capability',
                    directToolName: 'mcp__wework_control__invoke_capability',
                    argumentsValue: { name: steps[stage][0], arguments: steps[stage][1]() },
                    searchCallId: `control-search-${stage}`,
                    toolCallId: `control-step-${stage}`,
                  }).events,
                  responseCompleted(id),
                ]
        } else if (serialized.includes(CREATED)) {
          events = [assistantMessage('WEWORK_CONTROL_CREATED_READY'), responseCompleted(id)]
        } else if (serialized.includes(FOLLOW_UP)) {
          followUpRequests += 1
          events = [assistantMessage('WEWORK_CONTROL_ORIGINAL_RESUMED'), responseCompleted(id)]
        } else if (serialized.includes(SOURCE)) {
          events = [assistantMessage('WEWORK_CONTROL_SOURCE_READY'), responseCompleted(id)]
        } else {
          throw new Error('Unexpected model request during control checkpoint')
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(createSse([responseCreated(id), ...events]))
      } catch (error) {
        failure = error
        response.writeHead(500)
        response.end('Workbench control checkpoint failed')
      }
      return true
    },

    async verify(control) {
      active = true
      const send = async prompt => {
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', COMPOSER)
        await selectE2EModel(control, undefined, undefined, WORKBENCH)
        await control.command('fill', COMPOSER, { value: prompt })
        await control.command('press', COMPOSER, { key: 'Enter' })
      }
      await send(SOURCE)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_CONTROL_SOURCE_READY',
      })
      const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const task = snapshot.workbench.currentRuntimeTask
      assert.ok(task?.deviceId && task.taskId, 'The UI must expose the actual source task address')
      sourceTaskId = task.taskId
      sourceId = `conv_${Buffer.from(JSON.stringify([task.deviceId, task.taskId])).toString('base64url')}`
      await send(CONTROLLER)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_CONTROL_COMPLETE',
        timeoutMs: uiTimeoutMs,
      })
      if (failure) throw failure
      assert.deepEqual(
        observed,
        steps.map(step => step[0])
      )
      await control.command('click', `[data-testid="runtime-local-task-row-${sourceTaskId}"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_CONTROL_ORIGINAL_RESUMED',
      })
      assert.equal(followUpRequests, 1, 'A duplicate CI request must not start another native turn')
      await control.command('click', `[data-testid="runtime-local-task-row-${createdTaskId}"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_CONTROL_CREATED_READY',
      })
    },

    diagnostics() {
      return {
        sourceTaskId,
        createdTaskId,
        stage,
        observed,
        followUpRequests,
        failure: failure?.message,
      }
    },
  }
}
