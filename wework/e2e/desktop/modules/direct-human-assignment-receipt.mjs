import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
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

/** Exercise the real automatic intake while only the model response is held. */
export function createDirectHumanAssignmentReceiptVerifier() {
  const marker = `DIRECT_HUMAN_ASSIGNMENT_RECEIPT_${process.pid}`
  const tag = `receipt-${process.pid}`
  let releaseModel
  const modelGate = new Promise(resolve => {
    releaseModel = resolve
  })
  let modelRequests = 0
  let latestReceipt = null

  return {
    async handleModelRequest(serialized, response, responseId) {
      if (!serialized.includes(marker)) return false
      modelRequests += 1
      await modelGate
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(responseId),
          assistantMessage(`${marker}: completed`),
          responseCompleted(responseId),
        ])
      )
      return true
    },

    async verify({
      control,
      request,
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
      } finally {
        releaseModel()
        if (configured) {
          await rpc('runtime.stand_in.personal.save', { userId: user.id, settings: original })
        }
      }
    },

    diagnostics() {
      return { modelRequests, receipt: latestReceipt }
    },
  }
}
