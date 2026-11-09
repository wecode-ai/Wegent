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
      rows => rows.find(row => row.device_id === previous.executionDeviceId),
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
  } finally {
    const latest = await rpc('runtime.stand_in.get', settingsParams())
    await rpc('runtime.stand_in.save', {
      ...settingsParams(),
      settings: { ...latest, enabled: false },
    })
  }
}
