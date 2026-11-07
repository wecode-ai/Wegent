import type { IssueAssignmentReceipt } from '@/api/deliveries'
import '@/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueAssignmentReceipts } from './IssueAssignmentReceipts'

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
  it('keeps the hovered receipt mounted while an unrelated Issue version refreshes', async () => {
    vi.useFakeTimers()
    const rows = [{ ...receipt, stand_in_received_at: '2026-11-07T19:09:38Z' }]
    const { api, rerender } = setup(8, rows)
    await act(async () => {})
    const icon = screen.getByTitle(/分身已接收/)
    fireEvent.pointerOver(icon)
    await act(async () => vi.advanceTimersByTimeAsync(400))
    let resolveRefresh!: (value: typeof rows) => void
    api.getIssueAssignmentReceipts.mockReturnValueOnce(
      new Promise(resolve => {
        resolveRefresh = resolve
      })
    )
    rerender(
      <IssueAssignmentReceipts
        api={api as never}
        issueId="issue"
        version={2}
        currentUserId={8}
        assigneeUserId={7}
      />
    )
    expect(screen.getByTitle(/分身已接收/)).toBe(icon)
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(screen.getByRole('tooltip')).toHaveTextContent('分身已接收')
    await act(async () => resolveRefresh(rows))
    expect(screen.getByTitle(/分身已接收/)).toBe(icon)
    expect(screen.getByRole('tooltip')).toHaveTextContent('分身已接收')
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

  it.each([
    { issueId: 'other-issue', assigneeUserId: 7 },
    { issueId: 'issue', assigneeUserId: 8 },
  ])('clears receipts when their scope changes: %o', async scope => {
    const { api, rerender } = setup(8, [
      { ...receipt, stand_in_received_at: '2026-11-07T19:09:38Z' },
    ])
    await act(async () => {})
    expect(screen.getByTitle(/分身已接收/)).toBeInTheDocument()
    api.getIssueAssignmentReceipts.mockReturnValueOnce(new Promise(() => {}))
    rerender(
      <IssueAssignmentReceipts api={api as never} {...scope} version={2} currentUserId={8} />
    )
    expect(screen.queryByTitle(/分身已接收/)).not.toBeInTheDocument()
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
})
