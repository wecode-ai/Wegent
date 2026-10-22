import assert from 'node:assert/strict'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`

/** The existing checkpoint supplies a real completed session and its delivery. */
export async function verifyLinkedTasksScrolling(control, { request, projectId, issueId }) {
  for (let index = 0; index < 9; index += 1) {
    await request(`/api/v1/cloud-projects/${projectId}/loop-items`, {
      method: 'POST',
      body: JSON.stringify({
        title: `Linked child ${index + 1}`,
        parent_id: issueId,
        notify_assignee: false,
      }),
    })
  }
  await control.command('openWeworkScheme', 'body', {
    value: `wework://boards/${projectId}/issues/${issueId}`,
  })
  const section = scoped('[data-testid="cloud-todo-tasks"]')
  const list = `${section} [data-testid="cloud-todo-task-list"]`
  const toggle = `${section} [data-testid="cloud-todo-toggle-tasks"]`
  const delivery = scoped('[data-testid="todo-detail-deliveries"]')
  const countRows = async () => Number(await control.command('getElementCount', `${list} > button`))
  const metrics = async selector =>
    JSON.parse(await control.command('getElementMetrics', selector))[0]

  await control.command('waitFor', `${section} [data-testid="cloud-todo-execution-task-count"]`, {
    text: '10',
  })
  assert.equal(await countRows(), 2, 'Linked tasks must start collapsed')
  await control.command('waitFor', delivery)
  await control.command('scrollIntoView', toggle)
  await control.command('click', toggle)
  await control.command('waitFor', `${toggle}[aria-expanded="true"]`)
  assert.equal(await countRows(), 10, 'Expand must reveal the full mixed task list')
  const before = await metrics(list)
  assert.ok(before.clientHeight > 0 && before.clientHeight <= 280)
  assert.ok(before.scrollHeight > before.clientHeight, 'Task rows must not shrink to fit')

  await control.command('scrollToBottomAsUser', list)
  const after = await metrics(list)
  const last = await metrics(`${list} > button:last-child`)
  assert.ok(after.scrollTop > 0, 'The linked task list must scroll')
  assert.equal(after.clientHeight, before.clientHeight)
  assert.ok(last.top >= after.top - 1 && last.bottom <= after.bottom + 1)
  await control.command('waitFor', toggle, { visible: true })
  await control.command('click', toggle)
  assert.equal(await countRows(), 2)
  assert.equal((await metrics(list)).scrollTop, 0)
  await control.command('waitFor', delivery)
  await control.command('click', toggle)
  assert.equal((await metrics(list)).scrollTop, 0, 'Reopening starts at the top')
}
