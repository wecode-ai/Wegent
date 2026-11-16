import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { readProjectChatMessages } from './project-chat-snapshot.mjs'
import { DEFAULT_MODEL_ID, MODEL_PROVIDER_ID } from './shared.mjs'
import {
  assistantMessage,
  createSse,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

async function assertScopedWork(request, issue, receipt, user) {
  const executions = await request(
    `/api/v1/cloud-projects/${receipt.projectId}/executions?include_terminal=true`
  )
  const matches = executions.items.filter(row => row.loopItemId === issue.id)
  assert.equal(matches.length, 1, 'One human assignment must create one scoped execution')
  const execution = matches[0]
  assert.equal(String(execution.id), receipt.executionId)
  assert.equal(execution.executorOwnerUserId, user.id)
  assert.equal(execution.executionScope, `human-assistant:${receipt.dispatchId}`)
  assert.equal(execution.runtimeTaskId, receipt.runtimeTaskId)

  const bindings = await request(`/api/v1/loop-items/${issue.id}/tasks`)
  assert.equal(bindings.length, 1, 'One human assignment must bind one private task')
  assert.equal(bindings[0].task_user_id, user.id)
  assert.equal(bindings[0].human_assignment_id, receipt.humanAssignmentId)
  assert.equal(bindings[0].assignment_id, receipt.assignmentId)
  assert.equal(bindings[0].execution_id, receipt.executionId)
  assert.equal(bindings[0].task_id, receipt.runtimeTaskId)
  return execution
}

function assignmentSummaries(messages, receipt) {
  return messages
    .filter(
      message =>
        message.metadata?.activity_type === 'human_assistant_result' &&
        message.metadata.execution_id === receipt.executionId &&
        message.metadata.assignment_id === receipt.assignmentId
    )
    .map(({ messageId, content, metadata, status }) => ({ messageId, content, metadata, status }))
}

async function sendOwnerPrivateFollowUp(rpc, task, receipt, user, privateMarker) {
  const commandId = `${receipt.runtimeTaskId}-owner-private-follow-up`
  const sent = await rpc('runtime.tasks.send', {
    taskId: receipt.runtimeTaskId,
    commandId,
    message: privateMarker,
    conversationContext: 'private_discussion',
    executionRequest: {
      task_id: receipt.runtimeTaskId,
      subtask_id: commandId,
      user_id: user.id,
      prompt: privateMarker,
      system_prompt: '',
      project_workspace_path: task.workspacePath,
      new_session: false,
      bot: [{ shell_type: 'Codex', name: 'Owner private follow-up' }],
      model_config: {
        model_id: DEFAULT_MODEL_ID,
        model_provider: MODEL_PROVIDER_ID,
        runtime_config: { codex: { use_user_config: true, configured: true } },
      },
    },
  })
  assert.equal(sent.accepted, true, sent.error)
  assert.equal(sent.taskId, receipt.runtimeTaskId)
}

async function verifyOwnerPrivateFollowUp({
  rpc,
  request,
  readIssue,
  projectChat,
  deviceId,
  completed,
  receipt,
  user,
  privateMarker,
  waitForValue,
  modelResponseTimeoutMs,
}) {
  const address = { deviceId, taskId: receipt.runtimeTaskId }
  const readConversation = async () => {
    const { task } = await rpc('runtime.tasks.get', { address })
    const transcript = await rpc('runtime.tasks.transcript', { address, refresh: true })
    assert.notEqual(task.executionState?.outcome, 'failed', 'The owner follow-up failed')
    return { task, transcript }
  }
  const before = await readConversation()
  const shared = await waitForValue(
    () => readProjectChatMessages(projectChat, completed.id, modelResponseTimeoutMs),
    messages => assignmentSummaries(messages, receipt).length === 1,
    'Automatic completion did not publish its shared summary',
    modelResponseTimeoutMs
  )
  const originalSummary = assignmentSummaries(shared, receipt)
  await sendOwnerPrivateFollowUp(rpc, before.task, receipt, user, privateMarker)
  const followedUp = await waitForValue(
    readConversation,
    value =>
      value.task.running === false &&
      value.transcript.turns?.at(-1)?.status === 'done' &&
      value.transcript.turns.at(-1).id !== before.transcript.turns.at(-1).id &&
      value.transcript.messages?.some(
        message => message.role === 'assistant' && JSON.stringify(message).includes(privateMarker)
      ),
    'The owner could not continue the completed assistant task privately',
    modelResponseTimeoutMs
  )
  assert.equal(followedUp.task.threadId, before.task.threadId)
  assert.equal(followedUp.transcript.turns.length, before.transcript.turns.length + 1)
  assert.equal(followedUp.task.runtimeHandle.origin.trigger, 'manual')
  assert.equal(followedUp.task.runtimeHandle.origin.manual, true)
  assert.equal(followedUp.task.runtimeHandle.origin.humanAssistantDispatchId, undefined)
  assert.equal(followedUp.task.runtimeHandle.origin.executionId, undefined)
  const current = await readIssue()
  assert.equal(current.assignee_user_id, user.id)
  assert.equal(current.status, completed.status)
  assert.equal(current.completed_at, null)
  assert.deepEqual(
    current.direct_human_assignment_receipt,
    completed.direct_human_assignment_receipt
  )
  assert.equal((await assertScopedWork(request, current, receipt, user)).status, 'completed')
  const currentShared = await readProjectChatMessages(
    projectChat,
    completed.id,
    modelResponseTimeoutMs
  )
  assert.deepEqual(assignmentSummaries(currentShared, receipt), originalSummary)
  assert.equal(JSON.stringify(currentShared).includes(privateMarker), false)
}

/** Exercise the real automatic intake while only the model response is held. */
export function createDirectHumanAssignmentReceiptVerifier() {
  const marker = `DIRECT_HUMAN_ASSIGNMENT_RECEIPT_${process.pid}`
  const privateMarker = `${marker}_PRIVATE_FOLLOW_UP`
  const tag = `receipt-${process.pid}`
  let releaseModel
  const modelGate = new Promise(resolve => {
    releaseModel = resolve
  })
  let modelRequests = 0
  let latestReceipt = null
  let verificationError = null

  return {
    async handleModelRequest(serialized, response, responseId) {
      if (!serialized.includes(marker)) return false
      modelRequests += 1
      await modelGate
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(responseId),
          assistantMessage(
            `${serialized.includes(privateMarker) ? privateMarker : marker}: completed`
          ),
          responseCompleted(responseId),
        ])
      )
      return true
    },

    async verify({
      control,
      request,
      backendUrl,
      authToken,
      projectId,
      user,
      waitForValue,
      uiTimeoutMs,
      modelResponseTimeoutMs,
    }) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const original = await rpc('runtime.stand_in.personal.get', { userId: user.id })
      assert.equal(original.lifecycle?.status ?? null, null, 'The isolated profile must be active')
      const device = await rpc('runtime.stand_in.device_identity', {})
      assert.ok(device.deviceId)
      let configured = false
      try {
        await rpc('runtime.stand_in.personal.save', {
          userId: user.id,
          settings: {
            ...original,
            executionDeviceId: device.deviceId,
            primary: {
              ...original.primary,
              enabled: true,
              prompt: `Handle the assigned Issue and reply with ${marker}: completed.`,
              preferences: '',
              executionDeviceId: device.deviceId,
              collaboration: {
                enabled: true,
                allProjects: false,
                projects: [{ id: String(projectId), store: 'cloud' }],
                excludedProjects: [],
                tags: [tag],
                policy: { automatic: true, askBeforeAct: false },
                projectPolicies: [],
              },
            },
          },
        })
        configured = true
        let issue = await request(`/api/v1/cloud-projects/${projectId}/loop-items`, {
          method: 'POST',
          body: JSON.stringify({ title: marker, tags: [tag], assignee_user_id: user.id }),
        })
        const readIssue = async () => {
          const value = await request(`/api/v1/loop-items/${issue.id}`)
          latestReceipt = value.direct_human_assignment_receipt
          assert.notEqual(latestReceipt?.state, 'failed', JSON.stringify(latestReceipt))
          return value
        }
        await waitForValue(
          readIssue,
          value => Boolean(value.direct_human_assignment_receipt?.executionId),
          'The persisted primary authorization did not create a scoped execution',
          modelResponseTimeoutMs
        )
        await waitForValue(
          async () => modelRequests,
          count => count > 0,
          'Automatic assignment never reached the real native model request',
          modelResponseTimeoutMs
        )
        issue = await waitForValue(
          readIssue,
          value => value.direct_human_assignment_receipt?.state === 'running',
          'Device acceptance did not project a running receipt',
          modelResponseTimeoutMs
        )
        const receipt = issue.direct_human_assignment_receipt
        assert.equal(receipt.projectId, String(projectId))
        assert.equal(receipt.issueId, issue.id)
        assert.equal(receipt.ownerUserId, user.id)
        assert.equal(receipt.humanAssignmentId, issue.human_task_binding.humanAssignmentId)
        assert.ok(receipt.runtimeTaskId)
        assert.equal(receipt.deliveryId, null)
        assert.equal(issue.assignee_user_id, user.id)
        assert.equal((await assertScopedWork(request, issue, receipt, user)).status, 'running')
        const native = await rpc('runtime.tasks.get', { taskId: receipt.runtimeTaskId })
        assert.equal(native.task.running, true)
        assert.ok(native.task.threadId, 'Acceptance must have a real native conversation')
        assert.equal(native.task.runtimeHandle.origin.standInId, '@primary')
        assert.equal(native.task.runtimeHandle.origin.humanAssignmentId, receipt.humanAssignmentId)

        for (let save = 0; save < 2; save += 1) {
          issue = await request(`/api/v1/loop-items/${issue.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ version: issue.version, tags: [tag] }),
          })
          assert.equal(
            issue.direct_human_assignment_receipt.humanAssignmentId,
            receipt.humanAssignmentId
          )
          assert.equal(issue.direct_human_assignment_receipt.executionId, receipt.executionId)
          await assertScopedWork(request, issue, receipt, user)
        }
        assert.equal(modelRequests, 1, 'Repeated saves must not start another native turn')
        releaseModel()
        const completed = await waitForValue(
          readIssue,
          value => value.direct_human_assignment_receipt?.state === 'completed',
          'Real native completion did not complete the assignment receipt',
          modelResponseTimeoutMs
        )
        await waitForValue(
          () => rpc('runtime.tasks.get', { taskId: receipt.runtimeTaskId }),
          value => value.task?.status === 'done' && value.task?.running === false,
          'The automatically accepted native task did not finish',
          modelResponseTimeoutMs
        )
        assert.equal(completed.assignee_user_id, user.id)
        assert.notEqual(
          completed.status,
          'completed',
          'Assistant completion must not complete the Issue'
        )
        assert.equal(completed.completed_at, null)
        assert.equal(completed.direct_human_assignment_receipt.deliveryId, null)
        assert.equal(completed.direct_human_assignment_receipt.executionId, receipt.executionId)
        assert.equal(
          (await assertScopedWork(request, completed, receipt, user)).status,
          'completed'
        )
        assert.equal(modelRequests, 1)
        await verifyOwnerPrivateFollowUp({
          rpc,
          request,
          readIssue,
          projectChat: { backendUrl, authToken, projectId },
          deviceId: device.deviceId,
          completed,
          receipt,
          user,
          privateMarker,
          waitForValue,
          modelResponseTimeoutMs,
        })
        assert.equal(modelRequests, 2, 'A private follow-up must start one new native turn')
      } catch (error) {
        verificationError = error
        throw error
      } finally {
        releaseModel()
        if (configured) {
          try {
            const current = await rpc('runtime.stand_in.personal.get', { userId: user.id })
            await rpc('runtime.stand_in.personal.save', {
              userId: user.id,
              settings: { ...original, version: current.version },
            })
          } catch (error) {
            if (verificationError) {
              throw new AggregateError(
                [verificationError, error],
                `Assignment verification failed: ${verificationError.message}; profile restoration failed: ${error.message}`
              )
            }
            throw error
          }
        }
      }
    },

    diagnostics() {
      return {
        modelRequests,
        receipt: latestReceipt,
        verificationError: verificationError
          ? String(verificationError.stack ?? verificationError)
          : null,
      }
    },
  }
}
