// @vitest-environment node
import { expect, test, vi } from 'vitest'
import { verifyWorkspaceTabReturn } from '../e2e/desktop/modules/workspace-tab-return.mjs'

vi.mock('../e2e/desktop/modules/goal-draft-flows.mjs', () => ({
  setGoalDraftForTabTransfer: vi.fn(),
  verifyTransferredGoalDraft: vi.fn(),
}))

test('waits for return acknowledgment before reading an already mounted fixed-tab editor', async () => {
  const ordinary = '普通标签页移回后保留的草稿'
  const fixed = '固定标签页移回后保留的草稿'
  let visibleDraft = ordinary
  let stagedDraft = ''
  let pending = false
  const valuesRead = []
  const detached = {
    async command(action, selector, options = {}) {
      if (action === 'fill') stagedDraft = options.value
      if (action === 'click' && selector === '[data-testid="workspace-tab-return-to-main"]')
        pending = true
    },
  }
  const control = {
    readyCount: 0,
    activateWindow() {},
    async awaitReadyAfter() {
      return { windowLabel: 'workspace-fixed' }
    },
    commandForWindow: (_label, ...args) => detached.command(...args),
    async command(action) {
      if (action === 'getWindowFocusSnapshot') {
        if (pending) visibleDraft = stagedDraft
        pending = false
        return JSON.stringify({ workspaceWindows: [] })
      }
      if (action === 'snapshot') return JSON.stringify({ testIds: ['workspace-tab-returned'] })
      if (action === 'getElementCount') return '0'
      if (action === 'getValue') {
        valuesRead.push(visibleDraft)
        return visibleDraft
      }
      return ''
    },
  }

  await verifyWorkspaceTabReturn(control, detached, 'returned', async () => {})
  expect(valuesRead).toEqual([ordinary, fixed])
  expect(pending).toBe(false)
})
