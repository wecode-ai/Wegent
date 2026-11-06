import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { verifyLocalExecutorUsesCloudSocketUrl } from '../modules/cloud-environment.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import { waitForScenarioProgress } from '../modules/scenario-progress.mjs'
import {
  findRuntimeWorkTask,
  waitForCompletedRuntimeTaskThread,
} from '../modules/runtime-task-evidence.mjs'
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
import {
  CLOUD_DEVICE_ID,
  REMOTE_DOCKER_DEVICE_ID,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_PUBLIC_MODEL_OPTIONS,
  selectE2EModel,
} from '../modules/shared.mjs'

const WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER = `${WORKBENCH} [data-testid="chat-message-input"][contenteditable="true"]`
const PR = 'https://github.com/synthetic/control-e2e/pull/43'
const SOURCE = 'WEWORK_CONTROL_SOURCE_E2E'
const SOURCE_MESSAGE = `${SOURCE}: this conversation owns ${PR}`
const CONTROLLER = 'WEWORK_CONTROL_CONTROLLER_E2E'
const CREATED = 'WEWORK_CONTROL_CREATED_E2E'
const CLOUD_CREATED = 'WEWORK_CONTROL_CLOUD_CREATED_E2E'
const CLOUD_FOLLOW_UP = 'WEWORK_CONTROL_CLOUD_FOLLOW_UP_E2E'
const CLOUD_UI_FOLLOW_UP = 'WEWORK_CONTROL_CLOUD_UI_FOLLOW_UP_E2E'
const RESOURCE_CONTENT = 'WEWORK_CONTROL_RESOURCE_CONTENT_E2E'
const UNIFIED_HISTORY = 'WEWORK_CONTROL_UNIFIED_HISTORY_E2E'
const REMOTE_CREATED = 'WEWORK_CONTROL_REMOTE_CREATED_E2E'
const REMOTE_FOLLOW_UP = 'WEWORK_CONTROL_REMOTE_FOLLOW_UP_E2E'
const REMOTE_UI_FOLLOW_UP = 'WEWORK_CONTROL_REMOTE_UI_FOLLOW_UP_E2E'
const SCOPED_CREATED = 'WEWORK_CONTROL_SCOPED_CREATED_E2E'
const SCOPED_FOLLOW_UP = 'WEWORK_CONTROL_SCOPED_FOLLOW_UP_E2E'
const CLOUD_TITLE = '发个评论帮我@control-e2e CONTROL_CLOUD_E2E'
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
  const output = readMcpToolOutput(body, callId)
  const error = findValue(output, value => value.isError === true)
  assert.equal(error, undefined, `Control MCP failed: ${output}`)
  return output
}

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs }) {
  let active = false
  let localControl
  let sourceId
  let sourceTaskId
  let sourceDeviceId
  let attachment
  let operationId
  let automationId
  let createdId
  let createdTaskId
  let cloudCreatedId
  let cloudCreatedTaskId
  let cloud
  let cloudEnvironment
  let httpProxy
  let cloudProject
  let scopedTask
  let scopedConversationId
  let scopedFollowUps = 0
  let storedCloudId
  const remoteIds = []
  const desktopTasks = new Map()
  const remoteOperationIds = new Map()
  const remoteFollowUpRequests = new Map()
  let stage = 0
  let followUpRequests = 0
  let cloudFollowUpRequests = 0
  let cloudUiFollowUpRequests = 0
  let remoteUiFollowUpRequests = 0
  let failure
  const progress = new EventEmitter()
  const request = async (path, body) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
    return response.json()
  }
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
      value => {
        const transcript = JSON.stringify(value)
        assert.ok(transcript.includes(SOURCE))
        assert.ok(transcript.includes(PR), 'Source transcript must retain the original PR URL')
      },
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
    [
      'create_conversation',
      () => ({
        message: CLOUD_CREATED,
        title: CLOUD_TITLE,
        project_space: { space_id: String(cloudProject.id), store: 'cloud' },
        options: { attachmentIds: [attachment.id] },
      }),
      async value => {
        const created = findValue(value, item => item.accepted === true && item.conversation_id)
        assert.ok(created)
        assert.equal(created.deviceId, sourceDeviceId)
        await waitForCompletedRuntimeTaskThread(localControl, created.taskId, uiTimeoutMs)
        const task = findRuntimeWorkTask(
          JSON.parse(await localControl.command('getLocalRuntimeWork', 'body')),
          created.taskId
        )
        assert.ok(task, 'The owning Executor must retain the created APP task')
        assert.equal(task.workspacePath, created.workspacePath)
        assert.ok(!['failed', 'cancelled'].includes(task.status))
        cloudCreatedId = created.conversation_id
        cloudCreatedTaskId = created.taskId
      },
    ],
    [
      'continue_conversation',
      () => ({
        conversation_id: cloudCreatedId,
        message: CLOUD_FOLLOW_UP,
        request_key: 'local-app:cloud-project:follow-up',
      }),
      value => {
        const receipt = findValue(value, item => item.operation && item.duplicate === false)
        assert.equal(
          receipt?.operation.delivery_status,
          'accepted',
          JSON.stringify({
            code: receipt?.operation.result?.code,
            accepted: receipt?.operation.result?.accepted,
            success: receipt?.operation.result?.success,
          })
        )
        assert.equal(receipt.operation.device_id, sourceDeviceId)
        assert.equal(receipt.operation.task_id, cloudCreatedTaskId)
      },
    ],
    [
      'continue_conversation',
      () => ({
        conversation_id: cloudCreatedId,
        message: CLOUD_FOLLOW_UP,
        request_key: 'local-app:cloud-project:follow-up',
      }),
      value => assert.ok(findValue(value, item => item.duplicate === true)),
    ],
    [
      'search_conversations',
      () => ({ query: CLOUD_TITLE, scope: 'current_device' }),
      value => {
        assert.ok(findValue(value, item => item.conversation_id === cloudCreatedId))
        const coverage = findValue(value, item => item.scope === 'owning_device')
        assert.equal(coverage?.unavailable_count, 0)
      },
    ],
    [
      'list_conversations',
      () => ({ limit: 100, scope: 'current_device' }),
      value => {
        assert.ok(findValue(value, item => item.conversation_id === cloudCreatedId))
        const coverage = findValue(value, item => item.scope === 'owning_device')
        assert.equal(coverage?.authorized_index_complete, true)
      },
    ],
  ]

  for (const deviceId of [CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID]) {
    steps.push(
      [
        'create_conversation',
        () => ({
          message: `${REMOTE_CREATED} ${UNIFIED_HISTORY}`,
          title: `Control remote query ${deviceId}`,
          options: {
            deviceId,
            runtime: 'codex',
            modelSelection: {
              modelName: CLOUD_PUBLIC_MODEL_NAME,
              modelType: 'public',
              options: CLOUD_PUBLIC_MODEL_OPTIONS,
            },
          },
        }),
        async value => {
          const created = findValue(value, item => item.accepted === true && item.conversation_id)
          assert.ok(created)
          remoteIds.push(created.conversation_id)
          const desktopTask = await cloudEnvironment.waitForRuntimeTask({
            deviceId: created.deviceId,
            taskId: created.taskId,
            workspacePath: created.workspacePath,
          })
          desktopTasks.set(created.conversation_id, desktopTask)
        },
      ],
      [
        'search_conversations',
        () => ({ device_id: deviceId, query: UNIFIED_HISTORY, limit: 100 }),
        value => {
          const page = findValue(
            value,
            item => Array.isArray(item.items) && item.coverage?.scope === 'device'
          )
          assert.ok(page)
          assert.equal(page.coverage.device_id, deviceId)
          assert.equal(page.coverage.authorized_index_complete, true)
          assert.equal(page.coverage.sources.length, 1)
          assert.equal(page.coverage.sources[0].source_id, deviceId)
          assert.ok(page.items.some(item => item.conversation_id === remoteIds.at(-1)))
        },
      ],
      [
        'continue_conversation',
        () => ({
          conversation_id: remoteIds.at(-1),
          message: `${REMOTE_FOLLOW_UP} ${deviceId}`,
          request_key: `remote-ci:${deviceId}:43:head:run:1`,
        }),
        async value => {
          const receipt = findValue(value, item => item.operation && item.duplicate === false)
          assert.equal(receipt?.operation.delivery_status, 'accepted')
          assert.equal(receipt.operation.device_id, deviceId)
          remoteOperationIds.set(deviceId, receipt.operation.operation_id)
          const task = desktopTasks.get(remoteIds.at(-1))
          assert.equal(receipt.operation.result.taskId, task.taskId)
          await cloudEnvironment.waitForRuntimeTask({
            deviceId,
            taskId: task.taskId,
            workspacePath: task.workspacePath,
          })
        },
      ],
      [
        'continue_conversation',
        () => ({
          conversation_id: remoteIds.at(-1),
          message: `${REMOTE_FOLLOW_UP} ${deviceId}`,
          request_key: `remote-ci:${deviceId}:43:head:run:1`,
        }),
        value => assert.ok(findValue(value, item => item.duplicate === true)),
      ],
      [
        'get_operation',
        () => ({ operation_id: remoteOperationIds.get(deviceId) }),
        value => {
          const receipt = findValue(value, item => item.operation?.device_id === deviceId)
          assert.equal(receipt?.operation.delivery_status, 'accepted')
          assert.equal(receipt.current_conversation, null)
        },
      ],
      [
        'read_conversation',
        () => ({ conversation_id: remoteIds.at(-1), limit: 100 }),
        value => {
          assert.ok(JSON.stringify(value).includes(`${REMOTE_FOLLOW_UP} ${deviceId}`))
          assert.ok(JSON.stringify(value).includes('WEWORK_CONTROL_REMOTE_RESUMED'))
        },
      ]
    )
  }
  steps.push(
    [
      'continue_conversation',
      () => ({
        conversation_id: scopedConversationId,
        message: SCOPED_FOLLOW_UP,
        request_key: 'scoped-original-43',
      }),
      async value => {
        const receipt = findValue(value, item => item.operation && item.duplicate === false)
        assert.equal(receipt?.operation.delivery_status, 'accepted')
        assert.equal(receipt.operation.result.taskId, scopedTask.taskId)
        assert.equal(receipt.operation.device_id, CLOUD_DEVICE_ID)
        await cloudEnvironment.waitForRuntimeTask({
          deviceId: receipt.operation.device_id,
          taskId: scopedTask.taskId,
          workspacePath: scopedTask.workspacePath,
        })
      },
    ],
    [
      'read_conversation',
      () => ({ conversation_id: scopedConversationId, limit: 100 }),
      value => {
        assert.ok(JSON.stringify(value).includes(SCOPED_FOLLOW_UP))
        assert.ok(JSON.stringify(value).includes('WEWORK_CONTROL_SCOPED_RESUMED'))
      },
    ],
    [
      'search_conversations',
      () => ({ query: UNIFIED_HISTORY, limit: 100, include_archived: true }),
      value => {
        const page = findValue(
          value,
          item => Array.isArray(item.items) && item.coverage?.scope === 'all'
        )
        assert.ok(page)
        for (const id of [storedCloudId, ...remoteIds]) {
          assert.equal(page.items.filter(item => item.conversation_id === id).length, 1)
        }
        for (const [id, desktopTask] of desktopTasks) {
          const conversation = page.items.find(item => item.conversation_id === id)
          assert.equal(conversation.taskId, desktopTask.taskId)
          assert.equal(conversation.title, desktopTask.title)
          assert.equal(conversation.workspacePath, desktopTask.workspacePath)
        }
        assert.equal(page.coverage.authorized_index_complete, true)
        for (const source of ['cloud_history', CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID]) {
          assert.ok(
            page.coverage.sources.some(
              item => item.source_id === source && item.status === 'available'
            )
          )
        }
      },
    ],
    ...[() => storedCloudId, () => remoteIds[0], () => remoteIds[1]].map(id => [
      'read_conversation',
      () => ({ conversation_id: id(), limit: 100 }),
      value => assert.ok(JSON.stringify(value).includes(UNIFIED_HISTORY)),
    ])
  )

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', {})
      const workspace = await request('/api/v1/workspaces', { name: `Control ${process.pid}` })
      cloudProject = await request('/api/v1/cloud-projects', {
        workspace_id: workspace.id,
        name: `Control ${process.pid}`,
        task_provider: 'local',
        visibility: 'private',
      })
      const form = new FormData()
      form.set('file', new Blob([RESOURCE_CONTENT], { type: 'text/plain' }), 'control-resource.txt')
      const upload = await fetch(`${cloud.backendUrl}/api/attachments/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cloud.authToken}` },
        body: form,
        signal: AbortSignal.timeout(uiTimeoutMs),
      })
      assert.equal(upload.status, 200, `Attachment upload: ${await upload.clone().text()}`)
      attachment = await upload.json()
      assert.ok(attachment.id)
      assert.equal(attachment.status, 'ready')
      const teamsResponse = await fetch(`${cloud.backendUrl}/api/teams?page=1&limit=100`, {
        headers: { Authorization: `Bearer ${cloud.authToken}` },
        signal: AbortSignal.timeout(uiTimeoutMs),
      })
      assert.ok(teamsResponse.ok)
      const teams = await teamsResponse.json()
      assert.ok(teams.items?.[0]?.id, 'Cloud history requires a real Agent fixture')
      const stored = await request('/api/tasks/create', {
        title: 'Control stored cloud conversation',
        prompt: UNIFIED_HISTORY,
        team_id: teams.items[0].id,
        client_origin: 'wework',
        task_type: 'task',
      })
      assert.ok(stored.id)
      storedCloudId = `cloudconv_${stored.id}`
      // Only REST uses this real forwarding proxy; Runtime sockets must use
      // the distinct endpoint supplied by the server's existing metadata.
      httpProxy = await new TransportFaultProxy(cloud.backendUrl).start()
      httpProxy.disconnectWebSockets(true)
    },
    setCloudEnvironment(environment) {
      cloudEnvironment = environment
      environment.backendUrl = httpProxy.url
    },
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
            await steps[stage][2]?.(value)
            observed.push(steps[stage][0])
            stage += 1
            progress.emit('change')
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
        } else if (serialized.includes(SCOPED_FOLLOW_UP)) {
          scopedFollowUps += 1
          events = [assistantMessage('WEWORK_CONTROL_SCOPED_RESUMED'), responseCompleted(id)]
        } else if (serialized.includes(SCOPED_CREATED)) {
          events = [assistantMessage('WEWORK_CONTROL_SCOPED_READY'), responseCompleted(id)]
        } else if (serialized.includes(REMOTE_UI_FOLLOW_UP)) {
          remoteUiFollowUpRequests += 1
          events = [assistantMessage('WEWORK_CONTROL_REMOTE_UI_RESUMED'), responseCompleted(id)]
        } else if (serialized.includes(REMOTE_FOLLOW_UP)) {
          const deviceId = [CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID].find(id =>
            serialized.includes(`${REMOTE_FOLLOW_UP} ${id}`)
          )
          assert.ok(deviceId, 'Remote continuation must retain its addressed device')
          remoteFollowUpRequests.set(deviceId, (remoteFollowUpRequests.get(deviceId) ?? 0) + 1)
          events = [assistantMessage('WEWORK_CONTROL_REMOTE_RESUMED'), responseCompleted(id)]
        } else if (serialized.includes(REMOTE_CREATED)) {
          events = [assistantMessage('WEWORK_CONTROL_REMOTE_READY'), responseCompleted(id)]
        } else if (serialized.includes(CLOUD_UI_FOLLOW_UP)) {
          cloudUiFollowUpRequests += 1
          events = [assistantMessage('WEWORK_CONTROL_CLOUD_UI_RESUMED'), responseCompleted(id)]
        } else if (serialized.includes(CLOUD_FOLLOW_UP)) {
          cloudFollowUpRequests += 1
          events = [assistantMessage('WEWORK_CONTROL_CLOUD_RESUMED'), responseCompleted(id)]
        } else if (serialized.includes(CLOUD_CREATED)) {
          assert.ok(
            serialized.includes(RESOURCE_CONTENT),
            'Owned attachment must reach the local turn'
          )
          events = [assistantMessage('WEWORK_CONTROL_CLOUD_READY'), responseCompleted(id)]
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
        progress.emit('change')
        response.writeHead(500)
        response.end('Workbench control checkpoint failed')
      }
      return true
    },

    async verify(control) {
      localControl = control
      await verifyLocalExecutorUsesCloudSocketUrl(control, cloudEnvironment)
      const { workspacePath } = cloudEnvironment
      assert.ok(typeof workspacePath === 'string' && workspacePath.length > 0)
      active = true
      const issue = await request(`/api/v1/cloud-projects/${cloudProject.id}/loop-items`, {
        title: 'Scoped continuation',
      })
      const scoped = await request('/api/runtime-work/create', {
        schemaVersion: 2,
        deviceId: CLOUD_DEVICE_ID,
        workspacePath,
        runtime: 'codex',
        message: SCOPED_CREATED,
        modelId: CLOUD_PUBLIC_MODEL_NAME,
        modelType: 'public',
        modelOptions: CLOUD_PUBLIC_MODEL_OPTIONS,
        cloudProjectId: String(cloudProject.id),
        origin: {
          type: 'board_task',
          cloudProjectId: String(cloudProject.id),
          loopItemId: String(issue.id),
          dispatch_role: 'executor',
        },
      })
      assert.equal(scoped.accepted, true)
      assert.equal(scoped.workspacePath, workspacePath)
      assert.equal(scoped.deviceId, CLOUD_DEVICE_ID)
      const scopedAddress = {
        deviceId: scoped.deviceId,
        taskId: scoped.taskId,
        workspacePath: scoped.workspacePath,
      }
      scopedTask = await cloudEnvironment.waitForRuntimeTask(scopedAddress)
      scopedConversationId = `conv_${Buffer.from(JSON.stringify([CLOUD_DEVICE_ID, scoped.taskId])).toString('base64url')}`
      const scopedContext = await request('/api/runtime-work/transcript', {
        ...scopedAddress,
        conversationContextOnly: true,
        limit: 1,
      })
      assert.equal(scopedContext.taskId, scoped.taskId)
      assert.equal(scopedContext.workspacePath, workspacePath)
      assert.equal(scopedContext.origin.type, 'board_task')
      assert.equal(scopedContext.origin.cloudProjectId, String(cloudProject.id))
      assert.equal(scopedContext.origin.loopItemId, String(issue.id))
      assert.equal(scopedContext.origin.dispatch_role, 'executor')
      const send = async prompt => {
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', COMPOSER)
        await selectE2EModel(control, undefined, undefined, WORKBENCH)
        await control.command('fill', COMPOSER, { value: prompt })
        await control.command('press', COMPOSER, { key: 'Enter' })
      }
      await send(SOURCE_MESSAGE)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_CONTROL_SOURCE_READY',
      })
      const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const task = snapshot.workbench.currentRuntimeTask
      assert.ok(task?.deviceId && task.taskId, 'The UI must expose the actual source task address')
      sourceTaskId = task.taskId
      sourceDeviceId = task.deviceId
      const localDevice = snapshot.workbench.devices.find(
        device => device.device_type === 'local' && device.device_id === sourceDeviceId
      )
      assert.ok(
        localDevice?.runtime_instance_id,
        'The local source must expose its Runtime identity'
      )
      const devices = await cloudEnvironment.devices()
      assert.equal(
        devices.filter(
          device =>
            device.device_type === 'app' &&
            device.app_device_id === sourceDeviceId &&
            device.runtime_instance_id === localDevice.runtime_instance_id
        ).length,
        1,
        'The local source must use a real APP device subject to remote-control restrictions'
      )
      sourceId = `conv_${Buffer.from(JSON.stringify([task.deviceId, task.taskId])).toString('base64url')}`
      await send(CONTROLLER)
      await waitForScenarioProgress(
        progress,
        () => ({ step: stage, error: failure }),
        steps.length,
        modelResponseTimeoutMs
      )
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_CONTROL_COMPLETE',
        timeoutMs: modelResponseTimeoutMs,
      })
      if (failure) throw failure
      assert.equal(scopedFollowUps, 1, 'Scoped target must resume its original conversation')
      assert.deepEqual(
        observed,
        steps.map(step => step[0])
      )
      await control.command('click', `[data-testid="runtime-local-task-row-${sourceTaskId}"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_CONTROL_ORIGINAL_RESUMED',
      })
      assert.equal(followUpRequests, 1, 'A duplicate CI request must not start another native turn')
      const cloudRow = `[data-testid="runtime-local-task-row-${cloudCreatedTaskId}"]`
      await control.command('waitFor', cloudRow)
      await control.command('clickWhenEnabled', cloudRow)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_CONTROL_CLOUD_RESUMED',
      })
      assert.equal(cloudFollowUpRequests, 1, 'Local cloud-bound continuation must be idempotent')
      await control.command('fill', COMPOSER, { value: CLOUD_UI_FOLLOW_UP })
      await control.command('clickWhenEnabled', `${WORKBENCH} [data-testid="send-message-button"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_CONTROL_CLOUD_UI_RESUMED',
      })
      assert.equal(cloudUiFollowUpRequests, 1)
      const localResumed = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        .workbench.currentRuntimeTask
      assert.equal(localResumed.deviceId, sourceDeviceId)
      assert.equal(localResumed.taskId, cloudCreatedTaskId)
      for (const deviceId of [CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID]) {
        assert.equal(
          remoteFollowUpRequests.get(deviceId),
          1,
          `A duplicate CI request must not start another turn on ${deviceId}`
        )
      }
      const remoteTask = desktopTasks.get(remoteIds[0])
      const remoteRow = `[data-testid="runtime-local-task-row-${remoteTask.taskId}"]`
      await control.command('waitFor', remoteRow)
      await control.command('clickWhenEnabled', remoteRow)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_CONTROL_REMOTE_RESUMED',
      })
      await control.command('fill', COMPOSER, { value: REMOTE_UI_FOLLOW_UP })
      await control.command('clickWhenEnabled', `${WORKBENCH} [data-testid="send-message-button"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_CONTROL_REMOTE_UI_RESUMED',
      })
      if (failure) throw failure
      const resumed = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        .workbench.currentRuntimeTask
      assert.equal(resumed.deviceId, CLOUD_DEVICE_ID)
      assert.equal(resumed.taskId, remoteTask.taskId)
      assert.equal(resumed.workspacePath, remoteTask.workspacePath)
      assert.equal(
        remoteUiFollowUpRequests,
        1,
        'Desktop follow-up must send one original-task turn'
      )
      await control.command('click', `[data-testid="runtime-local-task-row-${createdTaskId}"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_CONTROL_CREATED_READY',
      })
    },

    async cleanup() {
      if (cloudEnvironment) cloudEnvironment.backendUrl = cloud.backendUrl
      await httpProxy?.stop()
    },

    diagnostics() {
      return {
        sourceTaskId,
        createdTaskId,
        cloudCreatedTaskId,
        storedCloudId,
        scopedConversationId,
        scopedFollowUps,
        remoteIds,
        stage,
        observed,
        followUpRequests,
        cloudFollowUpRequests,
        cloudUiFollowUpRequests,
        remoteUiFollowUpRequests,
        remoteFollowUpRequests: Object.fromEntries(remoteFollowUpRequests),
        failure: failure?.message,
      }
    },
  }
}
