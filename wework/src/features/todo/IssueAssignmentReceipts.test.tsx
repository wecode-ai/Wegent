import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { IssueAssignmentReceipt } from '@/api/deliveries'
import {
  IssueAssignmentReceipts,
  IssueAssignmentReceiptStatus,
  type IssueAssignmentReceiptState,
} from './IssueAssignmentReceipts'
import { useCallback, useState } from 'react'

const receipt: IssueAssignmentReceipt = {
  id: 'assignment-1',
  target_type: 'human',
  target_id: '7',
  target_name: 'Alice',
  receipt_tracking: true,
  human_read_at: null,
  stand_in_received_at: null,
}
function setup(user = 8, rows = [receipt], assignee: number | null = 7) {
  const api = {
    getLoopItem: vi.fn().mockResolvedValue({ id: 'issue' }),
    getIssueAssignmentReceipts: vi.fn().mockResolvedValue(rows),
    acknowledgeIssueAssignment: vi.fn().mockResolvedValue({ acknowledged: true }),
  }
  const view = render(
    <IssueAssignmentReceipts
      api={api as never}
      issueId="issue"
      version={1}
      currentUserId={user}
      assigneeUserId={assignee}
    />
  )
  return { api, ...view }
}
afterEach(() => vi.useRealTimers())

describe('Issue reception receipts', () => {
  it('shares live receipt updates with the activity without another polling request', async () => {
    vi.useFakeTimers()
    const onStateChange = vi.fn()
    const api = {
      getLoopItem: vi.fn().mockResolvedValue({ id: 'issue' }),
      getIssueAssignmentReceipts: vi.fn().mockResolvedValue([receipt]),
      acknowledgeIssueAssignment: vi.fn().mockResolvedValue({ acknowledged: true }),
    }
    function SharedReceipts() {
      const [state, setState] = useState<IssueAssignmentReceiptState | null>(null)
      const publish = useCallback((next: IssueAssignmentReceiptState) => {
        onStateChange(next)
        setState(next)
      }, [])
      return (
        <>
          <IssueAssignmentReceipts
            api={api}
            issueId="issue"
            version={1}
            currentUserId={8}
            assigneeUserId={7}
            onStateChange={publish}
          />
          {state ? <IssueAssignmentReceiptStatus {...state} /> : null}
        </>
      )
    }
    const { unmount } = render(<SharedReceipts />)
    await act(async () => {})
    expect(screen.getAllByText('未读')).toHaveLength(2)
    expect(api.getIssueAssignmentReceipts).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(api.getIssueAssignmentReceipts).toHaveBeenCalledTimes(2)
    expect(onStateChange).toHaveBeenCalledTimes(1)
    api.getIssueAssignmentReceipts.mockResolvedValue([
      { ...receipt, human_read_at: '2026-10-27T02:00:00Z' },
    ])
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(screen.getAllByText(/本人已读/)).toHaveLength(2)
    expect(api.getIssueAssignmentReceipts).toHaveBeenCalledTimes(3)
    expect(onStateChange).toHaveBeenCalledTimes(2)
    expect(api.acknowledgeIssueAssignment).not.toHaveBeenCalled()
    unmount()
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(api.getIssueAssignmentReceipts).toHaveBeenCalledTimes(3)
  })

  it('shows only receipts belonging to the displayed assignee', async () => {
    setup(9, [
      receipt,
      { ...receipt, id: 'other', target_id: '8', human_read_at: '2026-10-27T02:00:00Z' },
    ])
    expect(await screen.findByText('未读')).toBeInTheDocument()
    expect(screen.queryByTestId('issue-assignment-receipt-other')).not.toBeInTheDocument()
    expect(screen.queryByText(/本人已读/)).not.toBeInTheDocument()
  })

  it('does not attach another recipient receipt to an unassigned control', async () => {
    const { api } = setup(9, [receipt], null)
    await act(async () => {})
    expect(api.getIssueAssignmentReceipts).not.toHaveBeenCalled()
    expect(screen.queryByTestId('issue-assignment-receipt-assignment-1')).not.toBeInTheDocument()
  })

  it('does not show receipt synchronization errors on an unassigned control', async () => {
    vi.useFakeTimers()
    const { api, rerender } = setup(9)
    await act(async () => {})
    api.getIssueAssignmentReceipts.mockRejectedValue(new Error('offline'))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(screen.getByText('回执同步失败')).toBeInTheDocument()
    rerender(
      <IssueAssignmentReceipts
        api={api as never}
        issueId="issue"
        version={2}
        currentUserId={9}
        assigneeUserId={null}
      />
    )
    expect(screen.queryByText('回执同步失败')).not.toBeInTheDocument()
  })

  it('preserves local user zero when matching the current assignee', async () => {
    setup(9, [{ ...receipt, target_id: '0' }], 0)
    expect(await screen.findByText('未读')).toBeInTheDocument()
  })

  it('shows unread to the assigner without acknowledging on behalf of the recipient', async () => {
    const { api } = setup()
    expect(await screen.findByText('未读')).toBeInTheDocument()
    expect(api.acknowledgeIssueAssignment).not.toHaveBeenCalled()
  })

  it('acknowledges only after the recipient successfully loads the detail', async () => {
    const { api } = setup(7)
    api.acknowledgeIssueAssignment.mockImplementation(async () => {
      api.getIssueAssignmentReceipts.mockResolvedValue([
        { ...receipt, human_read_at: '2026-10-27T02:00:00Z' },
      ])
    })
    await waitFor(() =>
      expect(api.acknowledgeIssueAssignment).toHaveBeenCalledWith('issue', 'assignment-1', 7)
    )
    expect(api.getLoopItem.mock.invocationCallOrder[0]).toBeLessThan(
      api.acknowledgeIssueAssignment.mock.invocationCallOrder[0]
    )
    expect(await screen.findByText(/本人已读/)).toBeInTheDocument()
  })

  it('does not acknowledge when detail loading fails and recovers on the next poll', async () => {
    vi.useFakeTimers()
    const { api } = setup(7)
    api.getLoopItem.mockRejectedValueOnce(new Error('unavailable'))
    await act(async () => {})
    expect(screen.getByText('回执同步失败')).toBeInTheDocument()
    expect(api.acknowledgeIssueAssignment).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(api.acknowledgeIssueAssignment).toHaveBeenCalledOnce()
  })

  it('does not acknowledge a detail kept mounted in an inactive workspace tab', async () => {
    vi.useFakeTimers()
    const api = {
      getLoopItem: vi.fn().mockResolvedValue({ id: 'issue' }),
      getIssueAssignmentReceipts: vi.fn().mockResolvedValue([receipt]),
      acknowledgeIssueAssignment: vi.fn().mockResolvedValue({ acknowledged: true }),
    }
    const view = (hidden: boolean) => (
      <div aria-hidden={hidden}>
        <IssueAssignmentReceipts
          api={api as never}
          issueId="issue"
          version={1}
          currentUserId={7}
          assigneeUserId={7}
        />
      </div>
    )
    const { rerender } = render(view(true))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(api.acknowledgeIssueAssignment).not.toHaveBeenCalled()
    rerender(view(false))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(api.acknowledgeIssueAssignment).toHaveBeenCalledOnce()
  })

  it('retains independent human and stand-in timestamps', async () => {
    const { api } = setup(7, [
      {
        ...receipt,
        human_read_at: '2026-10-27T02:00:00Z',
        stand_in_received_at: '2026-10-27T02:01:00Z',
      },
    ])
    expect(await screen.findByText(/本人已读/)).toBeInTheDocument()
    expect(screen.getByText(/分身已接收/)).toBeInTheDocument()
    const icons = screen.getByTestId('issue-assignment-receipts')
    expect(icons.querySelector('svg[data-figure="human"]')).not.toBeNull()
    expect(icons.querySelector('svg[data-figure="stand-in"]')).not.toBeNull()
    expect(api.acknowledgeIssueAssignment).not.toHaveBeenCalled()
  })

  it('distinguishes legacy records from unread tracked assignments', async () => {
    setup(8, [{ ...receipt, receipt_tracking: false }])
    expect(await screen.findByText('暂无接收记录')).toBeInTheDocument()
    expect(screen.queryByText('未读')).not.toBeInTheDocument()
  })

  it('refreshes the assigner view without reopening and stops polling after close', async () => {
    vi.useFakeTimers()
    const { api, unmount } = setup()
    await act(async () => {})
    api.getIssueAssignmentReceipts.mockResolvedValue([
      { ...receipt, stand_in_received_at: '2026-10-27T02:00:00Z' },
    ])
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(screen.getByText(/分身已接收/)).toBeInTheDocument()
    unmount()
    const count = api.getIssueAssignmentReceipts.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(api.getIssueAssignmentReceipts).toHaveBeenCalledTimes(count)
  })
})
