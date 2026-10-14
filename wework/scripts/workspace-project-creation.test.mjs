import assert from 'node:assert/strict'
import { test } from 'vitest'
import { openDirectProjectCreation } from '../e2e/desktop/modules/workspace-flows.mjs'

function projectCreationControl({ menuTrigger = false, menuCount = 0, dialogError } = {}) {
  const calls = []
  return {
    calls,
    async command(action, selector) {
      calls.push({ action, selector })
      if (action === 'getAttribute') return ''
      if (action === 'getElementCount') {
        return selector.endsWith('[aria-haspopup]') ? Number(menuTrigger) : menuCount
      }
      if (action === 'waitFor' && selector.includes('project-create-dialog') && dialogError) {
        throw dialogError
      }
      if (action === 'waitFor' || action === 'click') return undefined
      throw new Error(`Unexpected control action: ${action}`)
    },
  }
}

test.each([
  'collaboration-workspace-project-create',
  'collaboration-workspace-starter-create-project',
])('opens a direct project form with the desktop string attribute contract: %s', async testId => {
  const control = projectCreationControl()
  await openDirectProjectCreation(control, '[data-testid="workspace-content"]', testId)
  assert.equal(control.calls.filter(call => call.action === 'click').length, 1)
  assert.ok(
    control.calls.some(
      call =>
        call.action === 'waitFor' &&
        call.selector === '[data-testid="collaboration-project-create-dialog"]'
    )
  )
})

test('rejects a menu trigger before clicking it', async () => {
  const control = projectCreationControl({ menuTrigger: true })
  await assert.rejects(openDirectProjectCreation(control, 'main'), /must be a direct action/)
  assert.ok(control.calls.every(call => call.action !== 'click'))
})

test('rejects an intermediate menu after opening the form', async () => {
  const control = projectCreationControl({ menuCount: 1 })
  await assert.rejects(
    openDirectProjectCreation(control, 'main'),
    /must not open an intermediate menu/
  )
})

test('propagates a failure to open the real creation dialog', async () => {
  const failure = new Error('Creation dialog did not open')
  const control = projectCreationControl({ dialogError: failure })
  await assert.rejects(openDirectProjectCreation(control, 'main'), error => error === failure)
})
