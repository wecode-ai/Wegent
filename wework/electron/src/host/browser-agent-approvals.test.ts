import { afterEach, describe, expect, test, vi } from 'vitest'
import { BrowserAgentApprovals, BROWSER_APPROVAL_TIMEOUT_MS } from './browser-agent-approvals.js'

afterEach(() => vi.useRealTimers())

describe('BrowserAgentApprovals', () => {
  test.each([true, false])(
    'settles only the original request once (approved=%s)',
    async approved => {
      const changed = vi.fn()
      const approvals = new BrowserAgentApprovals(changed)
      const first = approvals.register('browser', 'fill', { error: { code: 'approval_required' } })!
      const second = approvals.register('browser', 'click', {
        error: { code: 'approval_required' },
      })!
      const firstResult = approvals.wait('browser', first.approvalId, new AbortController().signal)
      const secondResult = approvals.wait(
        'browser',
        second.approvalId,
        new AbortController().signal
      )
      expect(approvals.latest('browser')).toEqual(second)
      expect(() => approvals.resolve('other', second.approvalId, true)).toThrow('different label')
      approvals.resolve('browser', second.approvalId, approved)
      await expect(secondResult).resolves.toBe(approved ? 'approved' : 'rejected')
      expect(() => approvals.resolve('browser', second.approvalId, true)).toThrow('not found')
      expect(approvals.latest('browser')).toEqual(first)
      approvals.cancelLabel('browser')
      await expect(firstResult).resolves.toBe('cancelled')
      expect(approvals.latest('browser')).toBeNull()
      expect(changed).toHaveBeenCalledTimes(2)
    }
  )

  test('expires a pending operation without a second tool invocation', async () => {
    vi.useFakeTimers()
    const changed = vi.fn()
    const approvals = new BrowserAgentApprovals(changed)
    const approval = approvals.register('browser', 'fill', {
      error: { code: 'approval_required' },
    })!
    const result = approvals.wait('browser', approval.approvalId, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(BROWSER_APPROVAL_TIMEOUT_MS)
    await expect(result).resolves.toBe('expired')
    expect(approvals.latest('browser')).toBeNull()
    expect(changed).toHaveBeenCalledWith('browser')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('cancels and clears the original approval when its request disconnects', async () => {
    vi.useFakeTimers()
    const approvals = new BrowserAgentApprovals(vi.fn())
    const approval = approvals.register('browser', 'fill', {
      error: { code: 'approval_required' },
    })!
    const controller = new AbortController()
    const result = approvals.wait('browser', approval.approvalId, controller.signal)
    controller.abort()
    await expect(result).resolves.toBe('cancelled')
    expect(approvals.latest('browser')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(() => approvals.resolve('browser', approval.approvalId, true)).toThrow('not found')
  })
})
