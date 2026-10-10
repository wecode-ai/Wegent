import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/i18n'
import type { CloudLoopItem } from '@/api/deliveries'
import { HumanIssueWorkPanel } from './HumanIssueWorkPanel'

const baseItem = {
  id: 'HUMAN-1',
  status: 'in_progress',
  version: 2,
  assignee_user_id: 7,
  human_work: {
    assignment_id: 'assignment-1',
    assignee_user_id: 7,
    reviewer_user_id: 1,
    submission_message_id: null,
    submitted_by_user_id: null,
    state: 'none',
    result: '',
    return_reason: '',
    ai_draft_delivery_id: null,
    can_start: false,
    can_submit: true,
    can_review: false,
  },
} as CloudLoopItem

function workApi() {
  return {
    getLoopItem: vi.fn(async () => baseItem),
    getDelivery: vi.fn(async () => ({ markdown: '# AI draft' })),
    startHumanIssueWork: vi.fn(async () => ({ issue: baseItem })),
    submitHumanIssueWork: vi.fn(async () => ({ issue: baseItem })),
    reviewHumanIssueWork: vi.fn(async () => ({ issue: baseItem })),
  }
}

describe('HumanIssueWorkPanel', () => {
  it('collects one result, shows a read-only confirmation, and leaves AI assist optional', async () => {
    const api = workApi()
    const onUpdated = vi.fn()
    const onAiAssist = vi.fn()
    const user = userEvent.setup()
    render(
      <HumanIssueWorkPanel
        item={baseItem}
        api={api}
        onUpdated={onUpdated}
        onAiAssist={onAiAssist}
      />
    )

    expect(screen.getByTestId('human-issue-submit')).toBeDisabled()
    await user.click(screen.getByTestId('human-issue-ai-assist'))
    expect(onAiAssist).toHaveBeenCalledOnce()
    await user.type(screen.getByTestId('human-issue-result'), 'Checked release notes')
    await user.click(screen.getByTestId('human-issue-submit'))
    expect(screen.getByTestId('human-issue-work-dialog')).toHaveTextContent('Checked release notes')
    expect(screen.queryByTestId('human-issue-return-reason-input')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('human-issue-work-confirm'))

    await waitFor(() => {
      expect(api.submitHumanIssueWork).toHaveBeenCalledWith(
        'HUMAN-1',
        2,
        'Checked release notes',
        expect.any(String)
      )
      expect(onUpdated).toHaveBeenCalledWith(baseItem)
    })
  })

  it('requires only a return reason and preserves the previous result for resubmission', async () => {
    const api = workApi()
    const user = userEvent.setup()
    const reviewed = {
      ...baseItem,
      status: 'in_review',
      human_work: {
        ...baseItem.human_work!,
        state: 'submitted' as const,
        result: 'Checked release notes',
        can_submit: false,
        can_review: true,
      },
    }
    const view = render(<HumanIssueWorkPanel item={reviewed} api={api} onUpdated={vi.fn()} />)
    expect(screen.getByTestId('human-issue-submitted-result')).toHaveTextContent(
      'Checked release notes'
    )
    await user.click(screen.getByTestId('human-issue-request-changes'))
    expect(screen.getByTestId('human-issue-work-confirm')).toBeDisabled()
    await user.type(screen.getByTestId('human-issue-return-reason-input'), 'Add evidence')
    await user.click(screen.getByTestId('human-issue-work-confirm'))
    await waitFor(() =>
      expect(api.reviewHumanIssueWork).toHaveBeenCalledWith(
        'HUMAN-1',
        2,
        'request_changes',
        expect.any(String),
        'Add evidence'
      )
    )

    view.rerender(
      <HumanIssueWorkPanel
        item={{
          ...baseItem,
          human_work: {
            ...baseItem.human_work!,
            state: 'changes_requested',
            result: 'Checked release notes',
            return_reason: 'Add evidence',
          },
        }}
        api={api}
        onUpdated={vi.fn()}
      />
    )
    expect(screen.getByTestId('human-issue-result')).toHaveValue('Checked release notes')
    expect(screen.getByTestId('human-issue-return-reason')).toHaveTextContent('Add evidence')
  })

  it('inserts an AI delivery only after the person chooses to use its draft', async () => {
    const api = workApi()
    const user = userEvent.setup()
    render(
      <HumanIssueWorkPanel
        item={{
          ...baseItem,
          human_work: { ...baseItem.human_work!, ai_draft_delivery_id: 'delivery-1' },
        }}
        api={api}
        onUpdated={vi.fn()}
      />
    )

    expect(screen.getByTestId('human-issue-result')).toHaveValue('')
    expect(api.getDelivery).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('human-issue-use-ai-draft'))
    await waitFor(() => expect(screen.getByTestId('human-issue-result')).toHaveValue('# AI draft'))
    expect(api.getDelivery).toHaveBeenCalledWith('delivery-1')
    expect(api.submitHumanIssueWork).not.toHaveBeenCalled()
  })
})
