import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import { StandInProcessingSettings } from './StandInProcessingSettings'

it('disables a rule independently of manual mode, timing, and operation confirmation', () => {
  const onChange = vi.fn()
  const policy = { automatic: true, askBeforeAct: true, immediate: false }
  const row = {
    key: 'mail',
    name: '客户邮箱',
    testId: 'mail-policy',
    policy,
    onChange,
    onProcessingChange: vi.fn(),
  }
  const view = render(<StandInProcessingSettings rows={[row]} disabled={false} />)
  fireEvent.click(screen.getByTestId('mail-policy-enabled'))
  expect(onChange).toHaveBeenCalledWith({ ...policy, enabled: false })
  view.rerender(
    <StandInProcessingSettings
      rows={[{ ...row, policy: { ...policy, enabled: false } }]}
      disabled={false}
    />
  )
  expect(screen.getByTestId('mail-policy')).toBeDisabled()
  fireEvent.click(screen.getByTestId('mail-policy-enabled'))
  expect(onChange).toHaveBeenLastCalledWith({ ...policy, enabled: true })
})
