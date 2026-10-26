import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'

const FAILURE = 'STAND_IN_NOTIFICATION_MODEL_REJECTED'
const selector = id => `[data-testid=${JSON.stringify(id)}]`

export function createStandInFailureRegression() {
  let reject = true
  let requests = 0
  return {
    handleHttp(body, response) {
      if (!reject || !JSON.stringify(body).includes(FAILURE)) return false
      requests += 1
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: FAILURE, type: 'invalid_request_error' } }))
      return true
    },
    async verify(control, projectId, uiTimeoutMs, modelResponseTimeoutMs) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const issue = await rpc('todos.create', {
        project_id: projectId,
        todo: { title: FAILURE, assignee_user_id: 9001 },
      })
      const address = await rpc('runtime.stand_in.run', {
        projectId,
        issueId: issue.id,
        userId: 9001,
        projectStore: 'local',
      })
      const waitForStatus = async status => {
        const deadline = Date.now() + modelResponseTimeoutMs
        let result
        while (Date.now() < deadline) {
          result = await rpc('runtime.tasks.get', { taskId: address.taskId })
          if (result.task?.status === status) return
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        assert.fail(`Stand-in did not reach ${status}: ${JSON.stringify(result)}`)
      }
      await waitForStatus('failed')
      assert.ok(requests > 0, 'Failure must come from the real model transport')
      const id = `stand-in:${encodeURIComponent(`${address.deviceId}\0${address.taskId}`)}`
      const processing = selector(`notification-processing-${id}`)
      const status = selector(`notification-stand-in-status-${id}`)
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      await control.command('waitFor', status, { text: '处理失败' })
      await control.command('waitFor', `${processing} p`, { text: FAILURE })
      const text = await control.command('getText', processing)
      assert.ok(!/模型回复已完成|Model reply is ready/.test(text), text)
      reject = false
      await control.command('clickWhenEnabled', selector(`notification-stand-in-retry-${id}`))
      await waitForStatus('done')
      await control.command('waitFor', status, { text: '处理完毕' })
      await control.command('waitFor', processing, { text: '已完成任务，等待检查。' })
      const bindings = await rpc('todos.bindings', { task_id: issue.id })
      assert.equal(bindings.length, 1, 'Retry must reuse the original execution')
      assert.equal(bindings[0].task_id, address.taskId)
    },
  }
}
