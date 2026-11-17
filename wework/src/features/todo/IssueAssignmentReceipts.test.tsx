import type { IssueAssignmentReceipt } from '@/api/deliveries'
import '@/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueAssignmentReceipts } from './IssueAssignmentReceipts'
import { issueAssignmentRevision } from './issueAssignmentReceiptScope'

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
  it('preserves a hovered receipt while an unrelated issue revision is refreshed', async () => {
    vi.useFakeTimers()
    const rows = [{ ...receipt, stand_in_received_at: '2026-11-07T16:54:00Z' }]
    const api = {
      getLoopItem: vi.fn().mockResolvedValue({ id: 'issue' }),
      getIssueAssignmentReceipts: vi.fn().mockResolvedValue(rows),
      acknowledgeIssueAssignment: vi.fn(),
    }
    const view = (version: number, assigneeUserId = 7, issueId = 'issue') => (
      <IssueAssignmentReceipts
        api={api as never}
        issueId={issueId}
        version={version}
        assignmentRevision="assignment-1"
        currentUserId={8}
        assigneeUserId={assigneeUserId}
      />
    )
    const { rerender } = render(view(1))
    await act(async () => {})
    const icon = screen.getByTitle(/^助理已接收/)
    fireEvent.pointerOver(icon)
    await act(async () => vi.advanceTimersByTimeAsync(600))

    let resolveRefresh!: (rows: IssueAssignmentReceipt[]) => void
    api.getIssueAssignmentReceipts.mockReturnValueOnce(
      new Promise(resolve => {
        resolveRefresh = resolve
      })
    )
    rerender(view(2))
    expect(screen.getByTitle(/^助理已接收/)).toBe(icon)
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(screen.getByRole('tooltip')).toHaveTextContent('助理已接收')
    await act(async () => resolveRefresh(rows))
    expect(screen.getByTitle(/^助理已接收/)).toBe(icon)
    expect(screen.getByRole('tooltip')).toHaveTextContent('助理已接收')

    rerender(view(3, 9))
    expect(screen.queryByTitle(/^助理已接收/)).not.toBeInTheDocument()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    rerender(view(4, 7, 'another-issue'))
    expect(screen.queryByTitle(/^助理已接收/)).not.toBeInTheDocument()
  })

  it('identifies an assignment independently of history ordering and display names', () => {
    const entry = {
      at: '2026-11-07T18:35:58Z',
      action: 'assign' as const,
      by_user_id: 8,
      to_type: 'user' as const,
      to_id: '7',
      to_name: 'Alice',
    }
    const previous = { ...entry, at: '2026-11-07T18:30:00Z' }
    const revision = issueAssignmentRevision({ assignment_history: [previous, entry] })
    expect(issueAssignmentRevision({ assignment_history: [entry, previous] })).toBe(revision)
    expect(
      issueAssignmentRevision({ assignment_history: [previous, { ...entry, to_name: 'Renamed' }] })
    ).toBe(revision)
    expect(
      issueAssignmentRevision({
        assignment_history: [previous, entry, { ...entry, at: '2026-11-07T18:36:00Z' }],
      })
    ).not.toBe(revision)
    expect(issueAssignmentRevision({})).toBeUndefined()
  })

  it('preserves a pending receipt tooltip during a same-assignment Issue refresh', async () => {
    vi.useFakeTimers()
    const api = {
      getLoopItem: vi.fn(),
      getIssueAssignmentReceipts: vi
        .fn()
        .mockResolvedValue([{ ...receipt, stand_in_received_at: '2026-11-07T18:35:58Z' }]),
      acknowledgeIssueAssignment: vi.fn(),
    }
    const props = {
      api,
      issueId: 'issue',
      currentUserId: 8,
      assigneeUserId: 7,
      assignmentRevision: 'assignment-1',
    }
    const { rerender } = render(<IssueAssignmentReceipts {...props} version={1} />)
    await act(async () => {})
    const icon = screen.getByText('助理已接收').closest('[title]')!
    fireEvent.pointerOver(icon)
    await act(async () => vi.advanceTimersByTimeAsync(380))
    let finishOldRefresh!: (rows: IssueAssignmentReceipt[]) => void
    api.getIssueAssignmentReceipts.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishOldRefresh = resolve
        })
    )
    rerender(<IssueAssignmentReceipts {...props} version={2} />)
    expect(screen.getByText('助理已接收').closest('[title]')).toBe(icon)
    await act(async () => vi.advanceTimersByTimeAsync(320))
    expect(screen.getByRole('tooltip')).toHaveTextContent('助理已接收')
    let finishNewAssignment!: (rows: IssueAssignmentReceipt[]) => void
    api.getIssueAssignmentReceipts.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishNewAssignment = resolve
        })
    )
    rerender(<IssueAssignmentReceipts {...props} version={3} assignmentRevision="assignment-2" />)
    expect(screen.queryByText('助理已接收')).not.toBeInTheDocument()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    await act(async () =>
      finishOldRefresh([{ ...receipt, stand_in_received_at: '2026-11-07T18:35:58Z' }])
    )
    expect(screen.queryByText('助理已接收')).not.toBeInTheDocument()
    await act(async () => finishNewAssignment([{ ...receipt, id: 'assignment-2' }]))
    expect(screen.getByText('未读')).toBeInTheDocument()
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
    expect(screen.getByTitle(/助理已接收/)).toBeInTheDocument()
    api.getIssueAssignmentReceipts.mockReturnValueOnce(new Promise(() => {}))
    rerender(
      <IssueAssignmentReceipts api={api as never} {...scope} version={2} currentUserId={8} />
    )
    expect(screen.queryByTitle(/助理已接收/)).not.toBeInTheDocument()
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
