import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import { StandInImmediateSwitch } from './StandInImmediateSwitch'

it.each([
  { automatic: true, askBeforeAct: true },
  { automatic: true, askBeforeAct: false },
])('changes timing without changing the saved handling permissions: %j', async policy => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <StandInImmediateSwitch
      policy={{ ...policy, immediate: false }}
      disabled={false}
      label="Handle development messages immediately"
      testId="connection-immediate"
      onChange={onChange}
    />
  )
  await user.click(screen.getByTestId('connection-immediate'))
  expect(onChange).toHaveBeenCalledWith({ ...policy, immediate: true })
})

it('does not change timing while the owning settings are disabled', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <StandInImmediateSwitch
      policy={{ automatic: true, askBeforeAct: true, immediate: false }}
      disabled
      label="Handle immediately"
      testId="connection-immediate"
      onChange={onChange}
    />
  )
  await user.click(screen.getByTestId('connection-immediate'))
  expect(onChange).not.toHaveBeenCalled()
})

it('requires an explicit opt-in to restore an existing manual connection', async () => {
  const onChange = vi.fn()
  const user = userEvent.setup()
  render(
    <StandInImmediateSwitch
      policy={{ automatic: false, askBeforeAct: true, immediate: false }}
      disabled={false}
      label="Handle immediately"
      testId="manual-connection"
      onChange={onChange}
    />
  )
  expect(screen.getByTestId('manual-connection')).toBeDisabled()
  await user.click(screen.getByTestId('manual-connection'))
  expect(onChange).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('manual-connection-enable'))
  expect(onChange).toHaveBeenCalledWith({ automatic: true, askBeforeAct: true, immediate: false })
})
