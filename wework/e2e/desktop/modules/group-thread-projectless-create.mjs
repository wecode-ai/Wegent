import assert from 'node:assert/strict'

/** Create a Thread from the shared entry without associating a Project. */
export async function verifyProjectlessThreadCreation({
  control,
  content,
  groupId,
  uiTimeoutMs,
  captureScreenshot,
  capture,
}) {
  const scoped = id => `${content} [data-testid="${id}"]`
  const wait = (id, extra = {}) =>
    control.command('waitFor', scoped(id), { timeoutMs: uiTimeoutMs, ...extra })
  const click = id => control.command('click', scoped(id))
  await click('collaboration-primary-home')
  await wait('thread-creation-home')
  assert.equal(await control.command('getValue', scoped('thread-home-project')), '')
  await capture(control, 'group-thread-create-home.png')
  await click('thread-home-create')
  await control.command('waitFor', '[data-testid="thread-create-group-select"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('select', '[data-testid="thread-create-group-select"]', {
    value: groupId,
  })
  await control.command('click', '[data-testid="thread-create-group-next"]')
  await control.command('waitFor', '[data-testid="thread-create-context"]', {
    timeoutMs: uiTimeoutMs,
    text: '未关联项目',
  })
  const standaloneTitle = `无需项目的事项-${process.pid}`
  await control.command('fill', '[data-testid="cloud-todo-title"]', { value: standaloneTitle })
  assert.equal(
    await control.command('getAttribute', '[data-testid="cloud-todo-detail-description"]', {
      value: 'placeholder',
    }),
    '目标与验收标准'
  )
  await captureScreenshot(control, 'group-thread-create-without-project.png', 'body')
  await control.command('click', '[data-testid="cloud-todo-create-confirm"]')
  await wait('thread-room', { text: standaloneTitle })
  await click('thread-settings')
  await wait('thread-project-select')
  assert.equal(await control.command('getValue', scoped('thread-project-select')), '')
  await capture(control, 'group-thread-created-without-project.png')
  await click('thread-settings-close')
}
