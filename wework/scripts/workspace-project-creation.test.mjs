import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  openDirectProjectCreation,
  openProjectAgentCreator,
  expandCollaborationWorkspace,
} from '../e2e/desktop/modules/workspace-flows.mjs'

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

test.each(['cloud-project-chat-agent-editor', 'wework-agent-resource-creator'])(
  'chooses new Agent explicitly before waiting for the %s form',
  async editorTestId => {
    const calls = []
    const control = {
      async command(action, selector, options) {
        calls.push({ action, selector, options })
      },
    }
    await openProjectAgentCreator(
      control,
      'main [data-testid="project-agent-add"]',
      10000,
      editorTestId
    )
    assert.deepEqual(
      calls.map(({ action, selector }) => [action, selector]),
      [
        ['clickWhenEnabled', 'main [data-testid="project-agent-add"]'],
        ['waitFor', '[data-testid="project-agent-mode-create-card"]'],
        ['click', '[data-testid="project-agent-mode-create-card"]'],
        ['waitFor', `[data-testid="${editorTestId}"]`],
      ]
    )
    assert.equal(calls.at(-1).options.timeoutMs, 10000)
  }
)

test('does not open an Agent form when the creation choice is unavailable', async () => {
  const calls = []
  const failure = new Error('Creation choice is not accessible')
  const control = {
    async command(action, selector) {
      calls.push({ action, selector })
      if (action === 'waitFor') throw failure
    },
  }
  await assert.rejects(
    openProjectAgentCreator(control, '[data-testid="project-agent-add"]', 10000),
    error => error === failure
  )
  assert.equal(calls.length, 2)
})

test.each(['true', 'false'])(
  'ensures a workspace is open from its initial aria-expanded=%s state',
  async expanded => {
    const calls = []
    const control = {
      async command(action, selector, options) {
        calls.push({ action, selector, options })
        if (action === 'getAttribute') return expanded
      },
    }
    const toggle = '[data-testid="collaboration-workspace-toggle-guest-parent"]'
    await expandCollaborationWorkspace(control, toggle)
    assert.equal(calls.filter(call => call.action === 'click').length, expanded === 'false' ? 1 : 0)
    assert.deepEqual(calls.at(-1), {
      action: 'waitFor',
      selector: `${toggle}[aria-expanded="true"]`,
      options: { visible: true, timeoutMs: 10000 },
    })
  }
)

test('rejects a workspace toggle without a declared expanded state', async () => {
  const calls = []
  const control = {
    async command(action) {
      calls.push(action)
      if (action === 'getAttribute') return ''
    },
  }
  await assert.rejects(
    expandCollaborationWorkspace(control, '[data-testid="workspace-toggle"]'),
    /must expose its expanded state/
  )
  assert.ok(!calls.includes('click'))
})
