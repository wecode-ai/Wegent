import assert from 'node:assert/strict'

/** Model only the native metadata boundary; calendar and Gantt checks stay in their fixtures. */
export function createScheduleThreadFixture(snapshotSelector) {
  const metadata = { start_at: null, due_at: null }
  const groupId = 'schedule-owning-group'
  const threadId = 'schedule-thread'
  const reads = []
  return {
    reads,
    read(_control, method, params, timeoutMs) {
      assert.equal(method, 'todos.get')
      assert.deepEqual(params, { project_id: groupId, task_id: threadId })
      assert.ok(timeoutMs > 0)
      reads.push({ ...metadata })
      return Promise.resolve({
        id: threadId,
        group_id: groupId,
        cloud_project_id: groupId,
        metadata: { ...metadata },
      })
    },
    command(action, selector, options) {
      if (action === 'snapshot') {
        assert.equal(selector, snapshotSelector)
        return {
          handled: true,
          value: JSON.stringify({
            location: `http://schedule.test/todo?groupId=${groupId}&threadId=${threadId}`,
          }),
        }
      }
      if (action === 'fill') {
        const property = selector.endsWith('[data-testid="thread-settings-start"]')
          ? 'start_at'
          : selector.endsWith('[data-testid="thread-settings-due"]')
            ? 'due_at'
            : null
        assert.ok(property, `Unexpected schedule metadata field: ${selector}`)
        assert.match(options.value, /^\d{4}-\d{2}-\d{2}T12:00$/)
        metadata[property] = options.value
        return { handled: true, value: '' }
      }
      return { handled: false }
    },
  }
}
