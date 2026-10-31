import assert from 'node:assert/strict'

export async function verifySidebarHoverLifecycle(control, projectId, uiTimeoutMs) {
  const row = `[data-testid="project-row-${projectId}"]`
  const card = `[data-testid="project-hover-card-${projectId}"]`
  const pin = `[data-testid="project-hover-pin-${projectId}"]`
  const outside = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'

  await control.command('hover', row)
  await control.command('waitFor', card, { timeoutMs: uiTimeoutMs })
  await control.command('pointerLeave', row)
  await control.command('hover', card)
  await control.command('waitFor', card, { stableMs: 240, timeoutMs: uiTimeoutMs })

  // Pressing a button focuses it. Moving out before release does not activate
  // project pinning, but must still end the popup's hover lifetime.
  await control.command('pointerDownOnly', pin)
  assert.equal(
    await control.command('getActiveElementTestId', 'body'),
    `project-hover-pin-${projectId}`
  )
  console.info('[sidebar-hover] popup action retains focus after pointer down; moving outside')
  await control.command('pointerLeave', card)
  await control.command('pointerMove', outside)
  await control.command('pointerUp', pin)
  await control.command('waitFor', card, { visible: false, timeoutMs: uiTimeoutMs })
  console.info('[sidebar-hover] focused action did not retain the popup after pointer exit')

  // Reopening and explicit dismissal must still work after hover dismissal.
  await control.command('hover', row)
  await control.command('waitFor', card, { timeoutMs: uiTimeoutMs })
  await control.command('press', pin, { key: 'Escape' })
  await control.command('waitFor', card, { visible: false, timeoutMs: uiTimeoutMs })
  await control.command('hover', row)
  await control.command('waitFor', card, { timeoutMs: uiTimeoutMs })
  await control.command('pointerLeave', row)
  await control.command('pointerMove', outside)
  await control.command('waitFor', card, { visible: false, timeoutMs: uiTimeoutMs })
}
