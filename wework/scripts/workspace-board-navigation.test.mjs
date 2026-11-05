import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import {
  openBoardIssueDetailByText,
  verifyTrackedTaskSettledStatus,
} from '../e2e/desktop/modules/workspace-flows.mjs'

afterEach(() => vi.useRealTimers())

test('opens the persisted Issue when a runtime task projection has the same title', async () => {
  const clicks = []
  await openBoardIssueDetailByText(
    {
      async command(action, selector) {
        if (action === 'markElementWithText') {
          return selector.includes(':not([data-testid^="cloud-todo-card-drop-runtime:"])')
            ? 'cloud-todo-card-drop-issue-1'
            : 'cloud-todo-card-drop-runtime:device:task'
        }
        if (action === 'click') clicks.push(selector)
      },
    },
    '[data-testid="board"]',
    'Shared task title',
    'persisted-issue'
  )
  assert.deepEqual(clicks, [
    '[data-testid="board"] [data-testid="cloud-todo-card-drop-issue-1"] [data-testid="cloud-todo-card-issue-1"]',
  ])
})

test('waits for the persisted Issue to leave running after its runtime projection reaches review', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  let runningReads = 0
  const verification = verifyTrackedTaskSettledStatus({
    async command(action, selector) {
      if (action === 'getAttribute') return 'workspace-tab-select-board-work'
      if (action === 'snapshot') {
        return JSON.stringify({ location: 'http://localhost/?projectId=default-work-items' })
      }
      if (action === 'getText') {
        if (selector.includes('column-in_progress')) {
          runningReads += 1
          return Date.now() < 300 ? 'WEWORK_DESKTOP_E2E_TASK' : ''
        }
        return 'WEWORK_DESKTOP_E2E_TASK'
      }
    },
  })
  await vi.advanceTimersByTimeAsync(1000)
  await verification
  assert.ok(runningReads > 1)
})
