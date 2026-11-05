import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { StandInExecutorApi } from '@/api/standIn'
import { StandInOnboarding } from './StandInOnboarding'

function setup(completed = false) {
  const api = {
    onboarding: vi.fn(async () => ({ state: { version: 1, completed } })),
    completeOnboarding: vi.fn(async () => ({ state: { version: 1, completed: true } })),
  }
  const onClose = vi.fn()
  const view = render(
    <StandInOnboarding
      api={api as unknown as StandInExecutorApi}
      userId={7}
      deviceId="mac"
      onClose={onClose}
    >
      <p>Stand-in content</p>
    </StandInOnboarding>
  )
  return { ...view, api, onClose, user: userEvent.setup() }
}

describe('stand-in onboarding', () => {
  it('explains a different choice saved by another window and reloads the completed state', async () => {
    const { api, user } = setup()
    api.completeOnboarding.mockImplementationOnce(async () => ({
      state: { version: 1, completed: true, weeklyReview: false },
    }))
    await user.click(await screen.findByTestId('stand-in-onboarding-complete'))
    await screen.findByRole('alert')
    expect(screen.queryByText('Stand-in content')).not.toBeInTheDocument()
    api.onboarding.mockResolvedValueOnce({ state: { version: 1, completed: true } })
    await user.click(screen.getByTestId('stand-in-onboarding-reload'))
    await screen.findByText('Stand-in content')
  })
  it('shows progress and prevents edits or duplicate submissions while saving', async () => {
    const { api, user } = setup()
    let finish!: () => void
    api.completeOnboarding.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ state: { version: 1, completed: true } })
        })
    )
    await user.click(await screen.findByTestId('stand-in-onboarding-complete'))
    expect(screen.getByTestId('stand-in-onboarding-complete')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByTestId('stand-in-onboarding-review')).toBeDisabled()
    expect(screen.getByTestId('stand-in-onboarding-time')).toBeDisabled()
    expect(screen.getByTestId('stand-in-onboarding-close')).toBeDisabled()
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    expect(api.completeOnboarding).toHaveBeenCalledOnce()
    await act(async () => finish())
    await screen.findByText('Stand-in content')
  })
  it('defaults to review without saving until confirmed, then opens the original content', async () => {
    const { api, user } = setup()
    expect(await screen.findByTestId('stand-in-onboarding-review')).toBeChecked()
    expect(screen.getByTestId('stand-in-onboarding-time')).toHaveValue('09:00')
    expect(api.completeOnboarding).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByText('Stand-in content')
    expect(api.completeOnboarding).toHaveBeenCalledWith(7, 'mac', true, '09:00', expect.any(String))
  })

  it('records an explicit opt-out', async () => {
    const { api, user } = setup()
    await user.click(await screen.findByTestId('stand-in-onboarding-review'))
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByText('Stand-in content')
    expect(api.completeOnboarding).toHaveBeenCalledWith(
      7,
      'mac',
      false,
      '09:00',
      expect.any(String)
    )
  })

  it('closing does not submit or complete onboarding', async () => {
    const { api, onClose, user } = setup()
    await user.click(await screen.findByTestId('stand-in-onboarding-close'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(api.completeOnboarding).not.toHaveBeenCalled()
  })

  it('retains the selection and edited time after a failed save and permits recovery', async () => {
    const { api, user } = setup()
    api.completeOnboarding.mockRejectedValueOnce(new Error('Save failed'))
    const input = await screen.findByTestId('stand-in-onboarding-time')
    await user.clear(input)
    await user.type(input, '10:30')
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByRole('alert')
    expect(input).toHaveValue('10:30')
    expect(screen.getByTestId('stand-in-onboarding-review')).toBeChecked()
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByText('Stand-in content')
  })

  it('does not show onboarding after completion', async () => {
    setup(true)
    await screen.findByText('Stand-in content')
    expect(screen.queryByTestId('stand-in-onboarding-review')).not.toBeInTheDocument()
  })

  it('ignores a late response from a different device', async () => {
    const { api, rerender, onClose } = setup(true)
    await screen.findByText('Stand-in content')
    api.onboarding.mockImplementationOnce(() => new Promise(() => {}))
    rerender(
      <StandInOnboarding
        key="other"
        api={api as unknown as StandInExecutorApi}
        userId={7}
        deviceId="other"
        onClose={onClose}
      >
        <p>Other device</p>
      </StandInOnboarding>
    )
    await waitFor(() => expect(api.onboarding).toHaveBeenCalledWith(7, 'other', expect.any(String)))
    expect(screen.queryByText('Stand-in content')).not.toBeInTheDocument()
    expect(screen.queryByText('Other device')).not.toBeInTheDocument()
  })
})
