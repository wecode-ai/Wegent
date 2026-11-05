import assert from 'node:assert/strict'

export function scheduleRuntimeControl(control, title) {
  const projectId = 'schedule-project'
  const origin = 'http://127.0.0.1:12345'
  const issue = {
    id: 'schedule-issue',
    title,
    metadata: { start_at: null, due_at: null },
  }
  const requests = []
  return {
    requests,
    async command(action, selector, options = {}) {
      if (action === 'snapshot') {
        return JSON.stringify({ location: `${origin}/?projectId=${projectId}` })
      }
      if (action === 'getLocationOrigin') return origin
      if (action === 'fetchLocalRuntime') {
        const request = JSON.parse(options.value)
        assert.equal(request.url, `${origin}/wework/executor/v1/rpc`)
        assert.equal(request.method, 'POST')
        const rpc = JSON.parse(request.body)
        requests.push(rpc)
        assert.equal(rpc.params.project_id, projectId)
        assert.ok(['todos.list', 'todos.get'].includes(rpc.method))
        if (rpc.method === 'todos.get') assert.equal(rpc.params.task_id, issue.id)
        return JSON.stringify({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ok: true,
            result: rpc.method === 'todos.list' ? [issue] : issue,
          }),
        })
      }
      if (action === 'fill') {
        if (selector === '[data-testid="cloud-todo-detail-start-date"]') {
          issue.metadata.start_at = options.value
        }
        if (selector === '[data-testid="cloud-todo-detail-due-date"]') {
          issue.metadata.due_at = options.value
        }
      }
      return control.command(action, selector, options)
    },
  }
}
