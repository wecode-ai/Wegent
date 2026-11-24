import assert from 'node:assert/strict'
import { withProjectRenderer } from './project-create-test-utils.mjs'

export async function verifyProjectMenuPointerInput(control, projectId, timeoutMs) {
  const row = `[data-testid="project-row-${projectId}"]`
  const item = `[data-testid="edit-project-${projectId}"]`
  const dialog = '[data-testid="local-project-edit-dialog"]'

  await control.command('contextMenu', row)
  await control.command('waitFor', item, { timeoutMs })

  const point = await withProjectRenderer(async (client, target) => {
    const command = (method, params) => client({ action: 'command', target, method, params })
    const movePointer = (x, y) => command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await movePointer(1, 1)
    const {
      result: {
        value: { x, y, hit, pointerEvents },
      },
    } = await command('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const option = document.querySelector(${JSON.stringify(item)})
        const bounds = option.getBoundingClientRect()
        const x = Math.floor(bounds.left + bounds.width / 2)
        const y = Math.floor(bounds.top + bounds.height / 2)
        return { x, y, hit: option.contains(document.elementFromPoint(x, y)),
          pointerEvents: getComputedStyle(option).pointerEvents }
      })()`,
    })
    assert.ok(
      hit,
      `Project menu item must receive pointer input outside the row (${pointerEvents})`
    )
    await movePointer(x, y)
    await control.command('waitFor', `${item}[data-highlighted]`, { timeoutMs })
    return { x, y }
  })

  await control.command('clickAt', 'body', { value: JSON.stringify(point) })
  await control.command('waitFor', dialog, { visible: true, timeoutMs })
  await control.command('click', '[data-testid="close-local-project-edit-dialog"]')
  await control.command('waitFor', dialog, { visible: false, timeoutMs })
}

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
