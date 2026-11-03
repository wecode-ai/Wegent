import assert from 'node:assert/strict'

export async function verifySidebarHoverLifecycle(control, projectId, uiTimeoutMs) {
  const row = `[data-testid="project-row-${projectId}"]`
  const card = `[data-testid="project-hover-card-${projectId}"]`
  const pin = `[data-testid="project-hover-pin-${projectId}"]`
  const outside = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'

  await control.command('hover', row)
  await control.command('waitFor', card, { timeoutMs: uiTimeoutMs })
  console.info('[sidebar-hover] project details visible; handing pointer from row to popup')
  await control.command('pointerLeave', row, { target: card })
  await control.command('waitFor', card, { stableMs: 240, timeoutMs: uiTimeoutMs })
  console.info('[sidebar-hover] pointer handoff preserved popup; focusing popup action')

  // Retain action focus without activating pinning or the native window.
  // Native activation allows an unrelated window blur to hide the defect.
  await control.command('focus', pin)
  assert.equal(
    await control.command('getActiveElementTestId', 'body'),
    `project-hover-pin-${projectId}`
  )
  console.info('[sidebar-hover] popup action retains focus; moving outside')
  await control.command('pointerLeave', card, { target: outside })
  await control.command('waitFor', card, { visible: false, timeoutMs: uiTimeoutMs })
  console.info('[sidebar-hover] focused action did not retain the popup after pointer exit')

  // Reopening and explicit dismissal must still work after hover dismissal.
  await control.command('hover', row)
  await control.command('waitFor', card, { timeoutMs: uiTimeoutMs })
  await control.command('press', pin, { key: 'Escape' })
  await control.command('waitFor', card, { visible: false, timeoutMs: uiTimeoutMs })
  await control.command('hover', row)
  await control.command('waitFor', card, { timeoutMs: uiTimeoutMs })
  await control.command('pointerLeave', row, { target: outside })
  await control.command('waitFor', card, { visible: false, timeoutMs: uiTimeoutMs })
}
