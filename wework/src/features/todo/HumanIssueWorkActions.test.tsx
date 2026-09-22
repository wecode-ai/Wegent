import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import { HumanIssueWorkActions } from './HumanIssueWorkActions'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

function issue(overrides: Partial<NonNullable<CloudLoopItem['human_work']>>): CloudLoopItem {
  return {
    id: 'issue-1',
    version: 4,
    human_work: {
      assignment_id: 'assignment-1',
      assignee_user_id: 2,
      reviewer_user_id: 1,
      submission_message_id: null,
      submitted_by_user_id: null,
      state: 'none',
      can_start: false,
      can_submit: false,
      can_review: false,
      ...overrides,
    },
  } as CloudLoopItem
}

function api() {
  return {
    startHumanIssueWork: vi.fn(),
    submitHumanIssueWork: vi.fn(),
    reviewHumanIssueWork: vi.fn(),
    getLoopItem: vi.fn(),
  }
}

describe('HumanIssueWorkActions', () => {
  it('starts assigned human work without starting an AI task', async () => {
    const workApi = api()
    const updated = issue({ can_submit: true })
    let resolveStart!: (value: { issue: CloudLoopItem }) => void
    workApi.startHumanIssueWork.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveStart = resolve
        })
    )
    const onUpdated = vi.fn()
    const onCreateTask = vi.fn()
    render(
      <HumanIssueWorkActions
        item={issue({ can_start: true })}
        api={workApi}
        onUpdated={onUpdated}
        onCreateTask={onCreateTask}
      />
    )

    const startButton = screen.getByTestId('human-issue-start')
    expect(screen.getByTestId('human-issue-actions')).toHaveClass('bg-muted/60')
    expect(startButton).toHaveClass('h-8', 'bg-primary', 'text-primary-contrast')

    fireEvent.click(startButton)

    expect(startButton).toBeDisabled()
    expect(startButton).toHaveAttribute('aria-busy', 'true')
    resolveStart({ issue: updated })

    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated))
    expect(workApi.startHumanIssueWork).toHaveBeenCalledWith('issue-1', 4)
    expect(onCreateTask).not.toHaveBeenCalled()
  })

  it('starts AI assistance without passing the click event as a workflow step', () => {
    const onCreateTask = vi.fn()
    render(
      <HumanIssueWorkActions
        item={issue({ can_submit: true })}
        api={api()}
        onUpdated={vi.fn()}
        onCreateTask={onCreateTask}
      />
    )

    fireEvent.click(screen.getByTestId('human-issue-ai-assist'))

    expect(screen.getByTestId('human-issue-submit')).toHaveClass('bg-primary')
    expect(screen.getByTestId('human-issue-ai-assist')).toHaveClass('bg-transparent')
    expect(onCreateTask).toHaveBeenCalledExactlyOnceWith()
  })

  it('requires a summary and submits it for review', async () => {
    const workApi = api()
    const updated = issue({ state: 'submitted' })
    workApi.submitHumanIssueWork.mockResolvedValue({ issue: updated })
    const onUpdated = vi.fn()
    render(
      <HumanIssueWorkActions
        item={issue({ can_submit: true })}
        api={workApi}
        onUpdated={onUpdated}
      />
    )

    fireEvent.click(screen.getByTestId('human-issue-submit'))
    expect(screen.getByTestId('human-issue-work-confirm')).toBeDisabled()
    fireEvent.change(screen.getByTestId('human-issue-work-text'), {
      target: { value: '  Implemented and tested  ' },
    })
    fireEvent.click(screen.getByTestId('human-issue-work-confirm'))

    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated))
    expect(workApi.submitHumanIssueWork).toHaveBeenCalledWith(
      'issue-1',
      4,
      'Implemented and tested',
      expect.any(String)
    )
  })

  it('requires a reason when the reviewer requests changes', async () => {
    const workApi = api()
    const updated = issue({ state: 'changes_requested' })
    workApi.reviewHumanIssueWork.mockResolvedValue({ issue: updated })
    const onUpdated = vi.fn()
    render(
      <HumanIssueWorkActions
        item={issue({ can_review: true, state: 'submitted' })}
        api={workApi}
        onUpdated={onUpdated}
      />
    )

    fireEvent.click(screen.getByTestId('human-issue-request-changes'))
    expect(screen.getByTestId('human-issue-accept')).toHaveClass('bg-primary')
    expect(screen.getByTestId('human-issue-request-changes')).toHaveClass('bg-transparent')
    expect(screen.getByTestId('human-issue-work-confirm')).toBeDisabled()
    fireEvent.change(screen.getByTestId('human-issue-work-text'), {
      target: { value: 'Add coverage' },
    })
    fireEvent.click(screen.getByTestId('human-issue-work-confirm'))

    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated))
    expect(workApi.reviewHumanIssueWork).toHaveBeenCalledWith(
      'issue-1',
      4,
      'request_changes',
      expect.any(String),
      'Add coverage'
    )
  })
})
