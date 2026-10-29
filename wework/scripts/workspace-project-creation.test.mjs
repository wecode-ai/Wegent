import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createAndAssignCloudIssue } from '../e2e/desktop/modules/workspace-agent-setup.mjs'
import {
  openDirectProjectCreation,
  openProjectAgentCreator,
  expandCollaborationWorkspace,
  selectCollaborationIssueAgent,
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
        ['waitFor', '[data-testid="project-agent-mode-create"]'],
        ['click', '[data-testid="project-agent-mode-create"]'],
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

test('leaves an already expanded workspace untouched', async () => {
  const calls = []
  const control = {
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'getAttribute') return 'true'
    },
  }
  const toggle = '[data-testid="collaboration-workspace-toggle-guest-parent"]'
  await expandCollaborationWorkspace(control, toggle)
  assert.equal(calls.filter(call => call.action === 'click').length, 0)
  assert.deepEqual(calls, [
    { action: 'waitFor', selector: toggle, options: { visible: true, timeoutMs: 10000 } },
    {
      action: 'getAttribute',
      selector: toggle,
      options: { value: 'aria-expanded' },
    },
  ])
})

test('expands a collapsed workspace and verifies the result', async () => {
  const calls = []
  const control = {
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'getAttribute') return 'false'
    },
  }
  const toggle = '[data-testid="collaboration-workspace-toggle-guest-parent"]'
  await expandCollaborationWorkspace(control, toggle)
  assert.equal(calls.filter(call => call.action === 'click').length, 1)
  assert.deepEqual(calls.at(-1), {
    action: 'waitFor',
    selector: `${toggle}[aria-expanded="true"]`,
    options: { visible: true, timeoutMs: 10000 },
  })
})

test('fails when one click does not expand the selected workspace', async () => {
  const calls = []
  const failure = new Error('Toggle collapsed again')
  const control = {
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'getAttribute') return 'false'
      if (action === 'waitFor' && selector.endsWith('[aria-expanded="true"]')) throw failure
    },
  }
  const toggle = '[data-testid="collaboration-workspace-toggle-guest-parent"]'
  await assert.rejects(expandCollaborationWorkspace(control, toggle), error => error === failure)
  assert.equal(calls.filter(call => call.action === 'click').length, 1)
})

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

test('waits for asynchronously loaded Agent options before selecting an assignee', async () => {
  const calls = []
  let optionReady
  const ready = new Promise(resolve => {
    optionReady = resolve
  })
  const trigger = 'main [data-testid="cloud-todo-detail-assignee"]'
  const option = '[data-testid="cloud-todo-detail-assignee-option-agent:shared-agent"]'
  const control = {
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'waitFor' && selector === option) await ready
    },
  }
  const selection = selectCollaborationIssueAgent(control, trigger, 'shared-agent')
  await Promise.resolve()
  assert.ok(!calls.some(call => call.action === 'click' && call.selector === option))
  optionReady()
  await selection
  assert.ok(calls.some(call => call.action === 'click' && call.selector === option))
  assert.equal(calls.at(-1).selector, `${trigger}[data-value="agent:shared-agent"]`)
})

test('does not select an Agent when the authorized option never becomes available', async () => {
  const clicks = []
  const failure = new Error('Authorized Agent option is unavailable')
  const control = {
    async command(action, selector) {
      if (action === 'click') clicks.push(selector)
      if (action === 'waitFor') throw failure
    },
  }
  const trigger = 'main [data-testid="cloud-todo-detail-assignee"]'
  await assert.rejects(
    selectCollaborationIssueAgent(control, trigger, 'missing-agent'),
    error => error === failure
  )
  assert.deepEqual(clicks, [trigger])
})

test('waits for the saved Issue editor before assigning a persisted Issue', async () => {
  const detailInteraction = Promise.withResolvers()
  const detailRendered = Promise.withResolvers()
  const issue = { id: 'issue-7', title: 'Assign after creation' }
  const trigger = 'main [data-testid="cloud-todo-detail-assignee"]'
  const option = '[data-testid="cloud-todo-detail-assignee-option-agent:agent-7"]'
  let persisted = false
  let rendered = false
  let selected = false
  let saved = false
  const control = {
    async command(action, selector) {
      if (
        action === 'clickWhenEnabled' &&
        selector.endsWith('[data-testid="cloud-todo-create-confirm"]')
      ) {
        persisted = true
      }
      if (selector === trigger) {
        detailInteraction.resolve()
        if (action === 'waitFor') await detailRendered.promise
        if (action === 'click') assert.ok(rendered, 'The creation panel is still saving')
      }
      if (action === 'click' && selector === option) selected = true
      if (action === 'clickWhenEnabled' && selector.endsWith('[data-testid="cloud-todo-save"]')) {
        assert.ok(rendered && selected, 'Assignment must be saved through the detail editor')
        saved = true
      }
    },
  }
  const request = async pathname => {
    assert.equal(pathname, '/api/v1/cloud-projects/project-7/loop-items')
    assert.ok(persisted)
    return { items: [issue] }
  }
  const outcome = createAndAssignCloudIssue(control, request, {
    contentSelector: 'main',
    projectId: 'project-7',
    title: issue.title,
    description: 'The server has persisted the Issue before the creation panel closes.',
    assigneeTarget: 'agent:agent-7',
    timeoutMs: 10000,
  }).then(
    value => ({ value }),
    error => ({ error })
  )

  await detailInteraction.promise
  assert.equal(selected, false)
  assert.equal(saved, false)
  rendered = true
  detailRendered.resolve()

  assert.deepEqual(await outcome, { value: issue })
  assert.ok(selected)
  assert.ok(saved)
})
