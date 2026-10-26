import assert from 'node:assert/strict'

export async function waitForVisibleBoardCard(control, selector) {
  await control.command('waitFor', selector)
  await control.command('scrollIntoView', selector)
  await control.command('waitFor', selector, { visible: true })
}

export async function waitForBoardValue(load, expected, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let actual
  while (Date.now() < deadline) {
    actual = await load()
    if (JSON.stringify(actual) === JSON.stringify(expected)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.deepEqual(actual, expected, message)
}

export async function dragBoardCard(control, source, target, timeoutMs) {
  await control.command('scrollIntoView', source)
  await control.command('scrollIntoView', target)
  await control.command('dragStart', source, { target })
  try {
    await control.command('waitFor', '[data-testid="project-board-drag-overlay"]', { timeoutMs })
  } finally {
    await control.command('dragEnd', source, { target })
  }
  await control.command('waitFor', '[data-testid="project-board-drag-overlay"]', {
    visible: false,
    timeoutMs,
  })
}
