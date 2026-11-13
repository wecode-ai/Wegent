import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { StandInReplyAuthorization } from './StandInReplyAuthorization'

function fixture(askBeforeAct = true, disabled = false) {
  const policy = { automatic: true, askBeforeAct, immediate: false }
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <StandInReplyAuthorization
      name="产品研发群"
      policy={policy}
      disabled={disabled}
      testId="source-reply-policy"
      onChange={onChange}
    />
  )
  return {
    policy,
    onChange,
    user,
    toggle: screen.getByTestId('source-reply-policy-confirm-replies'),
  }
}

describe('source reply authorization', () => {
  it('shows per-action confirmation without granting persistent authority on mount', () => {
    const { toggle, onChange } = fixture()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('发送前逐次确认')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('explains the exact scope before persistent authorization and allows cancellation', async () => {
    const { toggle, onChange, user } = fixture()
    await user.click(toggle)
    const dialog = screen.getByRole('dialog', { name: '持续允许助理回复？' })
    expect(dialog).toHaveTextContent('产品研发群')
    expect(dialog).toHaveTextContent('新收件人仍需确认')
    expect(dialog).toHaveTextContent('撤销持续授权')
    expect(onChange).not.toHaveBeenCalled()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(within(dialog).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('grants persistent reply authority only after the explicit scope confirmation', async () => {
    const { toggle, onChange, policy, user } = fixture()
    await user.click(toggle)
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('source-reply-policy-allow-replies'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...policy, askBeforeAct: false })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('revokes persistent authorization directly without changing intake or timing', async () => {
    const { toggle, onChange, policy, user } = fixture(false)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...policy, askBeforeAct: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.each([true, false])('does not mutate a disabled authorization setting: %s', async mode => {
    const { toggle, onChange, user } = fixture(mode, true)
    expect(toggle).toBeDisabled()
    await user.click(toggle)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
