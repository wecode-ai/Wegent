// @vitest-environment node

import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import {
  enrichTrackedDefaultIssueTitle,
  openTrackedWorkItemBoard,
} from '../e2e/desktop/modules/workspace-flows.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  DEFAULT_STEP_TIMEOUT_MS,
} from '../e2e/desktop/modules/shared.mjs'

afterEach(() => vi.useRealTimers())

const issuePanel = '[data-testid="work-item-context-panel"]'
const boardContent = '[data-testid="workspace-tab-content-board-7"]'
const activitySelector = `${boardContent} [data-testid="cloud-task-activity-WORK-3"]`
const reviewCardSelector = `${boardContent} [data-testid="cloud-todo-column-in_review"] [data-testid="cloud-todo-card-WORK-3"]`
const detailStatusSelector = `${boardContent} [data-testid="cloud-todo-detail-status"]`
const detailTitleSelector = `${boardContent} [data-testid="cloud-todo-detail-title"]`

function navigationControl({
  activityTestId = 'cloud-task-activity-WORK-3',
  snapshots = [boardSnapshot()],
  scopedSnapshots = [boardSnapshot()],
  focused = true,
  reviewCardCount = '1',
  detailStatus = 'in_review',
  detailTitle = 'WEWORK_DESKTOP_E2E_TASK',
} = {}) {
  const calls = []
  let snapshotIndex = 0
  let scopedSnapshotIndex = 0
  return {
    calls,
    async command(action, selector, options) {
      calls.push({ action, selector, options })
      if (action === 'getAttribute') {
        if (selector === boardContent) {
          assert.equal(options.value, 'aria-hidden')
          return String(!focused)
        }
        return selector.includes(issuePanel) ? activityTestId : 'workspace-tab-select-board-7'
      }
      if (action === 'snapshot') {
        assert.ok(selector === 'body' || selector === boardContent)
        const snapshot =
          selector === 'body'
            ? snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]
            : scopedSnapshots[Math.min(scopedSnapshotIndex++, scopedSnapshots.length - 1)]
        return JSON.stringify(snapshot)
      }
      if (action === 'getElementCount') {
        assert.equal(selector, reviewCardSelector)
        return reviewCardCount
      }
      if (action === 'getValue') {
        assert.ok(selector === detailStatusSelector || selector === detailTitleSelector)
        return selector === detailStatusSelector ? detailStatus : detailTitle
      }
      if (action === 'click' || action === 'waitFor') return undefined
      throw new Error(`Unexpected control action: ${action}`)
    },
  }
}

function boardSnapshot(params = {}, overrides = {}) {
  const search = new URLSearchParams({
    projectStore: 'local',
    projectId: 'default-work-items',
    ...params,
  })
  return {
    location: `http://127.0.0.1/wework/app/todo?${search}`,
    text: 'WEWORK_DESKTOP_E2E_TASK',
    testIds: ['cloud-todo-detail', 'cloud-task-activity-WORK-3'],
    ...overrides,
  }
}

test('verifies the bound Issue in its focused My Tasks tab after itemId is consumed', async () => {
  vi.useFakeTimers()
  const control = navigationControl({ snapshots: [boardSnapshot()] })
  const opening = openTrackedWorkItemBoard(control, issuePanel)
  await vi.advanceTimersByTimeAsync(500)
  assert.equal(await opening, boardContent)
  const identityRead = control.calls[0]
  assert.equal(identityRead.action, 'getAttribute')
  assert.ok(identityRead.selector.startsWith(`${issuePanel} section[`))
  assert.deepEqual(identityRead.options, { value: 'data-testid' })
  assert.equal(control.calls[1].selector, '[data-testid="work-item-open-board"]')
  assert.ok(
    control.calls.some(call => call.action === 'snapshot' && call.selector === boardContent)
  )
  assert.ok(control.calls.some(call => call.selector === reviewCardSelector))
  assert.ok(control.calls.some(call => call.selector === detailStatusSelector))
  assert.ok(control.calls.some(call => call.selector === detailTitleSelector))
  assert.deepEqual(control.calls.at(-1), {
    action: 'waitFor',
    selector: activitySelector,
    options: { visible: true, timeoutMs: DEFAULT_STEP_TIMEOUT_MS },
  })
})

test.each([
  [
    'another project store',
    { snapshots: [boardSnapshot(), boardSnapshot({ projectStore: 'cloud' })] },
  ],
  ['another project', { snapshots: [boardSnapshot(), boardSnapshot({ projectId: 'project-2' })] }],
  [
    'another Issue despite the expected activity elsewhere in the window',
    {
      scopedSnapshots: [
        boardSnapshot({}, { testIds: ['cloud-todo-detail', 'cloud-task-activity-WORK-4'] }),
      ],
    },
  ],
  ['an unfocused board', { focused: false }],
  [
    'loading board data',
    { scopedSnapshots: [boardSnapshot({}, { testIds: ['cloud-todo-board-loading'] })] },
  ],
  ['missing tracked task data', { scopedSnapshots: [boardSnapshot({}, { text: 'Another task' })] }],
  [
    'a missing focused detail',
    { scopedSnapshots: [boardSnapshot({}, { testIds: ['cloud-task-activity-WORK-3'] })] },
  ],
  ['the tracked card outside the awaiting-confirmation column', { reviewCardCount: '0' }],
  ['a tracked Issue still in progress', { detailStatus: 'in_progress' }],
  ['an unrelated detail title', { detailTitle: 'Another task' }],
])('rejects %s instead of accepting an unrelated board', async (_label, invalidState) => {
  vi.useFakeTimers()
  const control = navigationControl(invalidState)
  const outcome = openTrackedWorkItemBoard(control, issuePanel).then(
    () => null,
    error => error
  )
  await vi.advanceTimersByTimeAsync(DEFAULT_STEP_TIMEOUT_MS)
  assert.match((await outcome).message, /did not settle on the tracked task awaiting confirmation/)
  assert.ok(!control.calls.some(call => call.selector === activitySelector))
})

test('revalidates scoped Issue identity until it replaces an earlier selection', async () => {
  vi.useFakeTimers()
  const control = navigationControl({
    scopedSnapshots: [
      boardSnapshot({}, { testIds: ['cloud-todo-detail', 'cloud-task-activity-WORK-4'] }),
      boardSnapshot(),
    ],
  })
  const opening = openTrackedWorkItemBoard(control, issuePanel)
  await vi.advanceTimersByTimeAsync(600)
  assert.equal(await opening, boardContent)
})

test.each(['', 'cloud-task-activity-'])(
  'requires the source Issue identity: %j',
  async activityTestId => {
    const control = navigationControl({ activityTestId })
    await assert.rejects(
      openTrackedWorkItemBoard(control, issuePanel),
      /tracked Issue identity was unavailable/
    )
    assert.equal(control.calls.length, 1)
  }
)

test('preserves a focused Issue detail failure after the correct route loads', async () => {
  vi.useFakeTimers()
  const control = navigationControl({ snapshots: [boardSnapshot()] })
  const command = control.command.bind(control)
  const failure = new Error('Bound Issue detail did not mount')
  control.command = async (...args) => {
    if (args[0] === 'waitFor' && args[1] === activitySelector) throw failure
    return command(...args)
  }
  const outcome = openTrackedWorkItemBoard(control, issuePanel).then(
    () => null,
    error => error
  )
  await vi.advanceTimersByTimeAsync(500)
  assert.equal(await outcome, failure)
})

function issueEditingControl({ panelReady = Promise.resolve(), saveError } = {}) {
  const control = navigationControl({ snapshots: [boardSnapshot()] })
  const command = control.command.bind(control)
  const taskTab = '[data-testid="workspace-tab-select-fixed-task"]'
  const titleSelector = `${boardContent} [data-testid="cloud-todo-detail-title"]`
  const saveSelector = `${boardContent} [data-testid="cloud-todo-save"]`
  let surface = 'task'
  let detailsReady = false
  let draftTitle
  control.persistedTitle = 'WEWORK_DESKTOP_E2E_TASK'
  control.command = async (action, selector, options) => {
    if (action === 'waitFor' && selector.endsWith(issuePanel)) {
      await panelReady
      detailsReady = true
    }
    if (action === 'click' && selector === '[data-testid="work-item-open-board"]') {
      assert.ok(detailsReady, 'Navigation must wait for the bound Issue detail')
      surface = 'board'
    }
    if (selector === titleSelector) {
      assert.equal(surface, 'board', 'The Issue editor must belong to the focused board')
      if (action === 'fill') draftTitle = options.value
      if (action === 'press') {
        assert.equal(options.key, 'Enter')
        control.persistedTitle = draftTitle
      }
    }
    if (action === 'waitFor' && selector === saveSelector) {
      assert.ok(draftTitle, 'Saving must follow the Issue title edit')
      assert.equal(options.visible, false)
      if (saveError) throw saveError
    }
    if (action === 'click' && selector === taskTab) surface = 'task'
    if (action === 'waitFor' && selector === ACTIVE_COMPOSER_SELECTOR) {
      assert.equal(surface, 'task', 'Continue in the original task after saving the Issue')
    }
    if (action === 'fill' || action === 'press') {
      assert.equal(selector, titleSelector, 'Only the bound Issue title may be edited')
      control.calls.push({ action, selector, options })
      return
    }
    return command(action, selector, options)
  }
  return control
}

test('enriches the bound Issue through its detail entry and returns to the unchanged task', async () => {
  vi.useFakeTimers()
  const panelReady = Promise.withResolvers()
  const control = issueEditingControl({ panelReady: panelReady.promise })
  const title = 'WEWORK_DESKTOP_E2E_TASK additional Issue context'
  const editing = enrichTrackedDefaultIssueTitle(control, 'workspace-tab-select-fixed-task', title)
  await vi.advanceTimersByTimeAsync(0)
  assert.ok(control.calls.some(call => call.selector === '[data-testid="work-item-open-details"]'))
  assert.ok(!control.calls.some(call => call.selector === '[data-testid="work-item-open-board"]'))
  panelReady.resolve()
  await vi.advanceTimersByTimeAsync(500)
  await editing
  assert.equal(control.persistedTitle, title)
  assert.equal(control.calls.at(-1).selector, ACTIVE_COMPOSER_SELECTOR)
  assert.ok(
    control.calls.every(
      call => call.action !== 'click' || !call.selector.includes('cloud-todo-card-')
    )
  )
  assert.ok(control.calls.every(call => !call.selector.includes('work-item-open-board-menu')))
})

test('does not open a board or edit when the bound Issue detail fails', async () => {
  const failure = new Error('Bound Issue detail failed')
  const control = issueEditingControl({ panelReady: Promise.reject(failure) })
  await assert.rejects(
    enrichTrackedDefaultIssueTitle(control, 'workspace-tab-select-fixed-task', 'Updated Issue'),
    error => error === failure
  )
  assert.ok(control.calls.every(call => call.action !== 'getAttribute'))
  assert.ok(control.calls.every(call => call.action !== 'fill'))
})

test('preserves an Issue save failure without continuing in the task', async () => {
  vi.useFakeTimers()
  const failure = new Error('Issue save failed')
  const control = issueEditingControl({ saveError: failure })
  const outcome = enrichTrackedDefaultIssueTitle(
    control,
    'workspace-tab-select-fixed-task',
    'Updated Issue'
  ).then(
    () => null,
    error => error
  )
  await vi.advanceTimersByTimeAsync(500)
  assert.equal(await outcome, failure)
  assert.ok(!control.calls.some(call => call.selector === ACTIVE_COMPOSER_SELECTOR))
})
