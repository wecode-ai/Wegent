import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { reopenReceiptAfterReload } from '../e2e/desktop/modules/issue-assignment-receipts.mjs'

const { reloadMainWindow } = vi.hoisted(() => ({ reloadMainWindow: vi.fn() }))
vi.mock('../e2e/desktop/modules/workspace-flows.mjs', () => ({ reloadMainWindow }))

beforeEach(() => {
  vi.useFakeTimers()
  reloadMainWindow.mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

test('reconnected control does not reopen receipts until the mounted owner finishes loading', async () => {
  let mounted = false
  let loading = false
  const control = {
    command: vi.fn(async (action, selector) => {
      expect(action).toBe('getElementCount')
      return selector.includes('collaboration-platform-root')
        ? String(Number(mounted))
        : String(Number(loading))
    }),
  }
  const open = vi.fn()
  const reopened = reopenReceiptAfterReload(control, open)
  await vi.advanceTimersByTimeAsync(0)
  expect(reloadMainWindow).toHaveBeenCalledOnce()
  expect(open).not.toHaveBeenCalled()

  mounted = true
  loading = true
  await vi.advanceTimersByTimeAsync(100)
  expect(open).not.toHaveBeenCalled()

  loading = false
  await vi.advanceTimersByTimeAsync(100)
  await reopened
  expect(open).toHaveBeenCalledOnce()
})

test('propagates an owner readiness error without reopening or retrying it', async () => {
  const failure = new Error('The owner page could not be inspected')
  const command = vi.fn().mockRejectedValue(failure)
  const open = vi.fn()

  await expect(reopenReceiptAfterReload({ command }, open)).rejects.toBe(failure)

  expect(command).toHaveBeenCalledOnce()
  expect(open).not.toHaveBeenCalled()
})

test('preserves a failed controller reload before reading owner state', async () => {
  const failure = new Error('The controller did not reconnect')
  reloadMainWindow.mockRejectedValue(failure)
  const command = vi.fn()
  const open = vi.fn()

  await expect(reopenReceiptAfterReload({ command }, open)).rejects.toBe(failure)

  expect(command).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})
