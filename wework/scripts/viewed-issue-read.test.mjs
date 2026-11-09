import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { waitForViewedIssueRead } from '../e2e/desktop/modules/new-task-board-association.mjs'

test('the read prerequisite belongs to the final associated Issue, not the earlier moved Issue', async () => {
  const source = await readFile(
    new URL('../e2e/desktop/modules/workspace-flows.mjs', import.meta.url),
    'utf8'
  )
  const linked = source.indexOf("'workspace-10-existing-card-linked.png'")
  const read = source.indexOf(
    'await waitForViewedIssueRead(control, targetProjectName, existingTargetTitle)'
  )
  const draft = source.indexOf(
    'await verifyNewTaskBoardAssociation(control, targetProjectName, existingTargetTitle)'
  )
  assert.ok(linked >= 0 && read > linked && draft > read)
  assert.ok(
    source
      .slice(linked, read)
      .includes("await control.command('click', '[data-testid=\"work-item-guide-open-summary\"]')"),
    'Standalone checkpoints must explicitly open the associated detail before waiting for it'
  )
  assert.ok(
    source.slice(linked, read).includes("snapshot.testIds.includes('cloud-task-activity-list')")
  )
  assert.ok(
    !source.includes(
      "waitForViewedIssueRead(control, targetProjectName, 'WEWORK_DESKTOP_E2E_TASK')"
    )
  )
})

function fixture(loadItems) {
  const calls = []
  const control = {
    async command(action, selector, options) {
      if (action === 'getLocationOrigin') return 'http://isolated.test'
      assert.equal(action, 'fetchLocalRuntime')
      const request = JSON.parse(JSON.parse(options.value).body)
      calls.push(request.method)
      let result
      if (request.method === 'projects.list') result = [{ id: 'project', name: 'Viewed project' }]
      else {
        assert.equal(request.method, 'todos.list', 'Read readiness must never mutate the Issue')
        assert.deepEqual(request.params, { project_id: 'project' })
        result = loadItems()
      }
      return JSON.stringify({
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: true, result }),
      })
    },
  }
  return { control, calls }
}

test('viewed Issue readiness waits for its own read without consuming unrelated unread items', async () => {
  let reads = 0
  const { control, calls } = fixture(() => [
    { id: 'unrelated', title: 'Other Issue', metadata: { is_unread: true } },
    { id: 'viewed', title: 'Viewed Issue', metadata: { is_unread: ++reads === 1 } },
  ])
  await waitForViewedIssueRead(control, 'Viewed project', 'Viewed Issue')
  assert.equal(reads, 2, 'An unread baseline cannot be accepted before the real read completes')
  assert.deepEqual(calls, ['projects.list', 'todos.list', 'todos.list'])
})

test('viewed Issue readiness rejects a missing fixture instead of treating absence as read', async () => {
  const { control, calls } = fixture(() => [])
  await assert.rejects(
    waitForViewedIssueRead(control, 'Viewed project', 'Viewed Issue'),
    /previously viewed Issue must still exist/
  )
  assert.deepEqual(calls, ['projects.list', 'todos.list'])
})

test('viewed Issue readiness preserves read failures without retrying mutations', async () => {
  const failure = new Error('Read transport disconnected')
  const { control, calls } = fixture(() => {
    throw failure
  })
  await assert.rejects(
    waitForViewedIssueRead(control, 'Viewed project', 'Viewed Issue'),
    error => error.cause === failure
  )
  assert.deepEqual(calls, ['projects.list', 'todos.list'])
})
