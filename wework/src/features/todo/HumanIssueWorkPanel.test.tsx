import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  async function openNestedDialog(mode: 'submit' | 'return', api = workApi()) {
    const user = userEvent.setup()
    const parentShortcut = vi.fn()
    const item =
      mode === 'submit'
        ? baseItem
        : {
            ...baseItem,
            status: 'in_review',
            human_work: {
              ...baseItem.human_work!,
              state: 'submitted' as const,
              can_submit: false,
              can_review: true,
            },
          }
    render(
      <div
        onKeyDown={event => {
          if (event.key === 'Escape' || (event.ctrlKey && event.key === 'Enter')) {
            event.stopPropagation()
            parentShortcut()
          }
        }}
      >
        <HumanIssueWorkPanel item={item} api={api} onUpdated={vi.fn()} />
      </div>
    )
    if (mode === 'submit') await user.type(screen.getByTestId('human-issue-result'), 'Result')
    const trigger = screen.getByTestId(
      mode === 'submit' ? 'human-issue-submit' : 'human-issue-request-changes'
    )
    await user.click(trigger)
    return { user, trigger, parentShortcut }
  }

  it.each(['submit', 'return'] as const)(
    'traps focus and handles Escape within the %s dialog',
    async mode => {
      const { user, trigger, parentShortcut } = await openNestedDialog(mode)
      const cancel = screen.getByTestId('human-issue-work-cancel')
      const first =
        mode === 'submit' ? cancel : screen.getByTestId('human-issue-return-reason-input')
      expect(first).toHaveFocus()
      if (mode === 'return') await user.type(first, 'Revision needed')
      await user.tab({ shift: true })
      expect(screen.getByTestId('human-issue-work-confirm')).toHaveFocus()
      await user.tab()
      expect(first).toHaveFocus()
      await user.keyboard('{Control>}{Enter}{/Control}')
      expect(parentShortcut).not.toHaveBeenCalled()
      await user.keyboard('{Escape}')
      expect(screen.queryByTestId('human-issue-work-dialog')).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
      expect(parentShortcut).not.toHaveBeenCalled()
    }
  )

  it.each(['submit', 'return'] as const)(
    'protects the %s dialog while a request is busy and preserves failures',
    async mode => {
      const api = workApi()
      let rejectRequest!: (error: Error) => void
      const pending = () =>
        new Promise<{ issue: CloudLoopItem }>((_resolve, reject) => {
          rejectRequest = reject
        })
      if (mode === 'submit') api.submitHumanIssueWork.mockImplementation(pending)
      else api.reviewHumanIssueWork.mockImplementation(pending)
      const { user, parentShortcut } = await openNestedDialog(mode, api)
      if (mode === 'return')
        await user.type(screen.getByTestId('human-issue-return-reason-input'), 'Keep evidence')
      await user.click(screen.getByTestId('human-issue-work-confirm'))
      expect(screen.getByTestId('human-issue-work-cancel')).toBeDisabled()
      await user.keyboard('{Escape}')
      await user.tab()
      expect(screen.getByTestId('human-issue-work-dialog')).toHaveFocus()
      expect(parentShortcut).not.toHaveBeenCalled()
      await act(async () => rejectRequest(new Error('Try again')))
      expect(screen.getByTestId('human-issue-work-dialog')).toBeInTheDocument()
      if (mode === 'return')
        expect(screen.getByTestId('human-issue-return-reason-input')).toHaveValue('Keep evidence')
      else expect(screen.getByTestId('human-issue-work-dialog')).toHaveTextContent('Result')
      await user.click(screen.getByTestId('human-issue-work-cancel'))
    }
  )

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    'keeps IME Escape and Enter inside the dialog (%j)',
    async ime => {
      const api = workApi()
      const { user, parentShortcut } = await openNestedDialog('return', api)
      const input = screen.getByTestId('human-issue-return-reason-input')
      await user.type(input, '输入法候选')
      fireEvent.keyDown(input, { key: 'Escape', ...ime })
      fireEvent.keyDown(screen.getByTestId('human-issue-work-confirm'), { key: 'Enter', ...ime })
      expect(screen.getByTestId('human-issue-work-dialog')).toBeInTheDocument()
      expect(api.reviewHumanIssueWork).not.toHaveBeenCalled()
      expect(parentShortcut).not.toHaveBeenCalled()
    }
  )

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
