import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'

export async function verifyLocalCloudStandInReceipt(
  control,
  { request, settingsParams, userId },
  { workspacePath, marker, uiTimeoutMs, modelResponseTimeoutMs, until }
) {
  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const catalog = await rpc('runtime.runner.catalog', {})
  const model = catalog.models.find(row => row.runtime === 'codex' && row.is_default)
  assert.ok(model, 'The local App must expose its real default Codex model')
  const projectKey = `local-cloud-receipt-${process.pid}`
  await control.command('seedLocalProject', 'body', {
    value: JSON.stringify({ projectKey, name: projectKey, path: workspacePath }),
  })
  const previous = await rpc('runtime.stand_in.get', settingsParams())
  const identity = await rpc('runtime.stand_in.device_identity', {})
  assert.ok(identity.backendDeviceId, 'The local App must expose its unique Backend route')
  await rpc('runtime.stand_in.save', {
    ...settingsParams(),
    settings: {
      ...previous,
      enabled: true,
      tags: ['local-receipt'],
      model,
      workspace: { projectKey, workspacePath, executionMode: 'current_workspace' },
    },
  })
  try {
    const issue = await request(`/v1/cloud-projects/${settingsParams().projectId}/loop-items`, {
      title: `${marker}_LOCAL_APP_RECEIPT`,
      assignee_user_id: userId,
      tags: ['local-receipt'],
    })
    const binding = await until(
      () => request(`/v1/loop-items/${issue.id}/tasks`),
      rows => rows.find(row => row.device_id === identity.backendDeviceId),
      modelResponseTimeoutMs,
      'The local App did not bind its cloud assignment'
    )
    await until(
      () => rpc('runtime.tasks.get', { taskId: binding.task_id }),
      result => {
        assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
        return result.task?.status === 'done'
      },
      modelResponseTimeoutMs,
      'The local App did not complete its assigned work'
    )
    const assignment = await until(
      () => request(`/v1/loop-items/${issue.id}/assignments`),
      result => result.items.find(row => row.stand_in_received_at),
      uiTimeoutMs,
      'A started local-App task must persist its cloud reception receipt'
    )
    assert.equal(String(assignment.target_id), String(userId))
    assert.equal(assignment.human_read_at, null, 'Background execution is not a human detail read')
    const pending = await until(
      () => request(`/v1/loop-items/${issue.id}/assignments`),
      result =>
        result.items.find(
          row =>
            row.id === assignment.id &&
            row.dispatch_receipt?.reasonCode === 'awaiting_publication' &&
            typeof row.dispatch_receipt.publicMessageId === 'string' &&
            row.dispatch_receipt.publicMessageId.length > 0
        ),
      uiTimeoutMs,
      'Unconfirmed output must wait for the owning human to publish it'
    )
    assert.equal(pending.dispatch_receipt.state, 'waiting_user')
    assert.equal(pending.dispatch_receipt.confirmedMessageId, null)
    assert.equal(pending.dispatch_receipt.deliveryId, null)
    const commentPath = `/v1/cloud-projects/${settingsParams().projectId}/loop-items/${issue.id}/activity-comments`
    const comments = await request(commentPath)
    const result = comments.find(comment => comment.id === pending.dispatch_receipt.publicMessageId)
    assert.ok(result?.body.trim(), 'The receipt must reference the real execution result')
    assert.equal(result.generation_source, 'ai')
    assert.equal(result.confirmation_state, 'pending')
    const before = await request(`/v1/loop-items/${issue.id}`)
    const publication = await request(commentPath, {
      body: result.body,
      assistant_source: { device_id: binding.device_id, task_id: binding.task_id },
    })
    assert.equal(publication.generation_source, 'ai')
    assert.equal(publication.publication_source, 'human')
    assert.equal(publication.confirmation_state, 'authorized')
    const confirmed = await until(
      () => request(`/v1/loop-items/${issue.id}/assignments`),
      result =>
        result.items.find(
          row => row.id === pending.id && row.dispatch_receipt?.reasonCode === 'awaiting_delivery'
        ),
      uiTimeoutMs,
      'A confirmed publication must still wait for a real Delivery'
    )
    assert.equal(confirmed.dispatch_receipt.state, 'waiting_user')
    assert.equal(confirmed.dispatch_receipt.confirmedMessageId, publication.id)
    assert.equal(confirmed.dispatch_receipt.deliveryId, null)
    const draft = await request(`/v1/loop-items/${issue.id}/deliveries`, {
      title: `${marker}_LOCAL_APP_DELIVERY`,
      markdown: result.body,
      source_task: { device_id: binding.device_id, task_id: binding.task_id },
    })
    assert.equal(draft.status, 'draft')
    const delivery = await request(`/v1/deliveries/${draft.id}/finalize`, { fulfillments: [] })
    assert.equal(delivery.status, 'delivered')
    assert.equal(delivery.source_task_snapshot.taskId, binding.task_id)
    assert.equal(delivery.source_task_snapshot.deviceId, binding.device_id)
    const completed = await until(
      () => request(`/v1/loop-items/${issue.id}/assignments`),
      result =>
        result.items.find(
          row => row.id === pending.id && row.dispatch_receipt?.state === 'completed'
        ),
      uiTimeoutMs,
      'Published work must persist its assignment completion receipt'
    )
    const receipt = completed.dispatch_receipt
    assert.equal(receipt.issueId, issue.id)
    assert.equal(String(receipt.ownerUserId), String(userId))
    assert.equal(receipt.runtimeTaskId, binding.task_id)
    assert.ok(receipt.humanAssignmentId)
    assert.equal(receipt.publicMessageId, result.id)
    assert.equal(receipt.confirmedMessageId, publication.id)
    assert.equal(receipt.deliveryId, delivery.id)
    assert.ok(
      comments.some(comment => comment.id === receipt.publicMessageId && comment.body.trim()),
      'Completion must reference an actual public result from the owning execution'
    )
    assert.equal((await request(`/v1/loop-items/${issue.id}`)).status, before.status)
    const refreshed = await request(`/v1/loop-items/${issue.id}/assignments`)
    assert.deepEqual(
      refreshed.items.find(row => row.id === completed.id).dispatch_receipt,
      receipt,
      'Refreshing must preserve the completed receipt without restarting execution'
    )
  } finally {
    const latest = await rpc('runtime.stand_in.get', settingsParams())
    await rpc('runtime.stand_in.save', {
      ...settingsParams(),
      settings: { ...latest, enabled: false },
    })
  }
}
