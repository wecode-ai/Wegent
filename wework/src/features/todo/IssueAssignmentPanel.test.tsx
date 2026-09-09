import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import { IssueAssignmentPanel } from './IssueAssignmentPanel'

const item = {
  id: 'issue-1',
  title: 'Checkout',
  description: 'Updated description',
  workflow: {
    version: 1,
    definition_version: 1,
    intent: 'Original acceptance requirements',
    current_stage_id: null,
    initial_stage_id: 'release',
    current_work: 'Confirm checkout',
    orchestration_status: 'waiting_human',
    nodes: [{ id: 'release', name: 'Release', status: 'completed', depends_on: [] }],
    assignment: { id: 'assignment-3', status: 'waiting_human', assignee_user_id: 7 },
  },
} as CloudLoopItem

describe('IssueAssignmentPanel', () => {
  it.each(['failed', 'paused'] as const)(
    'does not imply the AI is working when unassigned and %s',
    orchestration_status => {
      render(
        <IssueAssignmentPanel
          item={{
            ...item,
            workflow: {
              ...item.workflow!,
              orchestration_status,
              assignment: undefined,
              current_work: '',
            },
          }}
          onUpdated={vi.fn()}
        />
      )
      expect(screen.getByTestId('issue-assignment-current-role')).toHaveTextContent(
        'todo.assignment_no_active_work'
      )
      expect(screen.queryByText('todo.assignment_planning')).not.toBeInTheDocument()
    }
  )
  it('keeps the submitted result visible while advancement is paused', () => {
    render(
      <IssueAssignmentPanel
        item={{
          ...item,
          workflow: {
            ...item.workflow!,
            orchestration_status: 'paused',
            assignment: {
              ...item.workflow!.assignment!,
              status: 'completed',
              result: 'Approval recorded',
            },
          },
        }}
        onUpdated={vi.fn()}
      />
    )
    expect(screen.getByTestId('issue-assignment-submitted-result')).toHaveTextContent(
      'Approval recorded'
    )
    expect(screen.queryByTestId('issue-assignment-result')).not.toBeInTheDocument()
  })
  it.each(['pending_confirmation', 'completed'])(
    'shows a result instead of ongoing work after automation completes (%s)',
    status => {
      render(
        <IssueAssignmentPanel
          item={{
            ...item,
            status,
            workflow: {
              ...item.workflow!,
              orchestration_status: 'completed',
              assignment: {
                ...item.workflow!.assignment!,
                status: 'completed',
                result: 'Checkout verified',
              },
            },
          }}
          onUpdated={vi.fn()}
        />
      )
      expect(screen.getByText('Checkout verified')).toBeInTheDocument()
      expect(screen.queryByText('Confirm checkout')).not.toBeInTheDocument()
      expect(screen.getByTestId('issue-assignment-completion')).toBeInTheDocument()
      expect(screen.queryByTestId('issue-assignment-result')).not.toBeInTheDocument()
    }
  )
  it('keeps the original goal and distinguishes work outside the graph', () => {
    render(
      <IssueAssignmentPanel
        item={item}
        currentUserId={8}
        submitResult={vi.fn()}
        onUpdated={vi.fn()}
      />
    )
    expect(screen.getByText('Original acceptance requirements')).toBeInTheDocument()
    expect(screen.getByText('Release')).toBeInTheDocument()
    expect(screen.getByTestId('issue-assignment-current-role')).not.toHaveTextContent('Release')
    expect(screen.queryByTestId('issue-assignment-submit-result')).not.toBeInTheDocument()
  })

  it('retains the human result after failure and submits it for the same assignment', async () => {
    const user = userEvent.setup()
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Connection interrupted'))
      .mockResolvedValueOnce(item.workflow)
    const updated = vi.fn()
    render(
      <IssueAssignmentPanel
        item={item}
        currentUserId={7}
        submitResult={submit}
        onUpdated={updated}
      />
    )
    const input = screen.getByTestId('issue-assignment-result')
    const button = screen.getByTestId('issue-assignment-submit-result')
    expect(button).toBeDisabled()
    await user.type(input, 'Checkout verified')
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByTestId('issue-assignment-human-control')).toHaveTextContent(
      'todo.assignment_human_control_help'
    )
    await user.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection interrupted')
    expect(input).toHaveValue('Checkout verified')
    expect(updated).not.toHaveBeenCalled()
    await user.click(button)
    expect(submit).toHaveBeenLastCalledWith('issue-1', 'assignment-3', 'Checkout verified')
    expect(updated).toHaveBeenCalledOnce()
    expect(input).toHaveValue('')
  })

  it('does not carry a result draft to another Issue', async () => {
    const user = userEvent.setup()
    const props = { currentUserId: 7, submitResult: vi.fn(), onUpdated: vi.fn() }
    const { rerender } = render(<IssueAssignmentPanel item={item} {...props} />)
    await user.type(screen.getByTestId('issue-assignment-result'), 'First Issue result')
    rerender(<IssueAssignmentPanel item={{ ...item, id: 'issue-2' }} {...props} />)
    expect(screen.getByTestId('issue-assignment-result')).toHaveValue('')
  })

  it('isolates a new assignment from an earlier pending submission on the same Issue', async () => {
    const user = userEvent.setup()
    let resolveResult!: (value: CloudLoopItem['workflow']) => void
    const submit = vi.fn().mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveResult = resolve
        })
    )
    const updated = vi.fn()
    const props = { currentUserId: 7, submitResult: submit, onUpdated: updated }
    const { rerender } = render(<IssueAssignmentPanel item={item} {...props} />)
    await user.type(screen.getByTestId('issue-assignment-result'), 'Release approved')
    await user.click(screen.getByTestId('issue-assignment-submit-result'))
    expect(screen.getByTestId('issue-assignment-result')).toBeDisabled()

    const nextItem = {
      ...item,
      workflow: {
        ...item.workflow!,
        current_work: 'Review the new revision',
        assignment: { ...item.workflow!.assignment!, id: 'assignment-4' },
      },
    }
    rerender(<IssueAssignmentPanel item={nextItem} {...props} />)
    expect(screen.getByTestId('issue-assignment-result')).toHaveValue('')
    expect(screen.getByTestId('issue-assignment-result')).toBeEnabled()
    await user.type(screen.getByTestId('issue-assignment-result'), 'Revision reviewed')
    await act(async () => resolveResult(item.workflow))
    expect(updated).not.toHaveBeenCalled()
    expect(screen.getByTestId('issue-assignment-result')).toHaveValue('Revision reviewed')
    expect(submit).toHaveBeenCalledExactlyOnceWith('issue-1', 'assignment-3', 'Release approved')
  })

  it('does not offer human submission without a known member identity', () => {
    render(
      <IssueAssignmentPanel
        item={{
          ...item,
          workflow: {
            ...item.workflow!,
            assignment: {
              ...item.workflow!.assignment!,
              assignee_user_id: undefined,
            },
          },
        }}
        submitResult={vi.fn()}
        onUpdated={vi.fn()}
      />
    )
    expect(screen.queryByTestId('issue-assignment-result')).not.toBeInTheDocument()
  })
})
