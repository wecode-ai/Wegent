import assert from 'node:assert/strict'

export async function assertDesktopPanes(
  control,
  { appSelector: APP, testId, privateInput: PRIVATE_INPUT, draft: DRAFT }
) {
  const metrics = async selector => JSON.parse(await control.command('getElementMetrics', selector))
  const visible = rows => rows.filter(row => row.width > 0 && row.height > 0)
  const headers = visible(
    await metrics(`${APP} .experience-header, ${APP} .experience-task-toolbar`)
  )
  assert.equal(
    headers.length,
    3,
    'Desktop must retain exactly the task, timeline and discussion headers'
  )
  for (const pane of ['tasks', 'timeline', 'discussion'])
    assert.equal(
      visible(await metrics(testId(`collaboration-exp-pane-header-${pane}`))).length,
      1,
      `The ${pane} pane must retain its own real header`
    )
  for (const header of headers) assert.equal(header.height, 60)
  const separators = visible(await metrics(`${APP} [role="separator"][data-separator]`))
  assert.ok(separators.length >= 2, 'Desktop pane boundaries must remain resizable')
  for (const boundary of ['tasks-timeline', 'timeline-discussion'])
    assert.equal(
      visible(await metrics(`${APP} #collaboration-exp-resize-${boundary}`)).length,
      1,
      `The ${boundary} boundary must remain independently resizable`
    )
  for (const separator of separators) assert.equal(separator.width, 8)
  const separator = `${APP} #collaboration-exp-resize-timeline-discussion`
  const timeline = testId('collaboration-exp-pane-timeline')
  const discussion = testId('collaboration-exp-pane-discussion')
  const sizes = async () => [
    (await metrics(timeline))[0].width,
    (await metrics(discussion))[0].width,
  ]
  const original = await sizes()
  await control.command('focus', separator)
  await control.command('press', separator, { key: 'ArrowRight' })
  const resized = await sizes()
  assert.ok(resized[0] > original[0] && resized[1] < original[1])
  assert.ok(Math.abs(resized[0] + resized[1] - original[0] - original[1]) < 2)
  await control.command('doubleClick', separator)
  const reset = await sizes()
  assert.ok(reset.every((width, index) => Math.abs(width - original[index]) < 2))
  await control.command('dragStart', separator, { target: timeline })
  try {
    const dragging = await sizes()
    assert.ok(Math.abs(dragging[0] - original[0]) > 1, 'The real drag must move before Escape')
    await control.command('press', separator, { key: 'Escape' })
    const cancelled = await sizes()
    assert.ok(cancelled.every((width, index) => Math.abs(width - original[index]) < 2))
    assert.equal(await control.command('getValue', PRIVATE_INPUT), DRAFT)
  } finally {
    await control.command('dragEnd', separator, { target: timeline })
  }
}
