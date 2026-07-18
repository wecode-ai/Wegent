import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { ApprovalCard } from './ApprovalCard'

describe('ApprovalCard', () => {
  test('submits a one-time approval', async () => {
    const onSubmit = vi.fn()
    render(
      <ApprovalCard
        payload={{ kind: 'approval', command: 'git push', reason: 'Requires network access' }}
        onSubmit={onSubmit}
      />
    )

    await userEvent.click(screen.getByTestId('runtime-approval-accept-button'))
    expect(onSubmit).toHaveBeenCalledWith({ decision: 'accept' })
  })

  test('shows a persistent action only for a Codex amendment', async () => {
    const onSubmit = vi.fn()
    const { rerender } = render(
      <ApprovalCard payload={{ kind: 'approval', command: 'git status' }} onSubmit={onSubmit} />
    )
    expect(screen.queryByTestId('runtime-approval-rule-button')).not.toBeInTheDocument()

    rerender(
      <ApprovalCard
        payload={{
          kind: 'approval',
          command: 'git status',
          proposedExecpolicyAmendment: { command: ['git', 'status'] },
        }}
        onSubmit={onSubmit}
      />
    )
    await userEvent.click(screen.getByTestId('runtime-approval-rule-button'))
    expect(onSubmit).toHaveBeenCalledWith({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicyAmendment: { command: ['git', 'status'] },
        },
      },
    })
  })
})
