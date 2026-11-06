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
  const onExampleSelect = vi.fn()
  const view = render(
    <StandInOnboarding
      api={api as unknown as StandInExecutorApi}
      userId={7}
      deviceId="mac"
      onClose={onClose}
      onExampleSelect={onExampleSelect}
    >
      <p>Stand-in content</p>
    </StandInOnboarding>
  )
  return { ...view, api, onClose, onExampleSelect, user: userEvent.setup() }
}

describe('stand-in onboarding', () => {
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
    expect(screen.getByTestId('stand-in-onboarding-example-weekly_review')).toBeDisabled()
    expect(screen.getByTestId('stand-in-onboarding-close')).toBeDisabled()
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    expect(api.completeOnboarding).toHaveBeenCalledOnce()
    await act(async () => finish())
    await screen.findByText('Stand-in content')
  })
  it('completes the introduction without creating a recurring review', async () => {
    const { api, user } = setup()
    await user.click(await screen.findByTestId('stand-in-onboarding-complete'))
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
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('stand-in-onboarding-content')).not.toHaveAttribute('inert')
  })

  it('shows a failed completion and permits recovery without scheduling work', async () => {
    const { api, user } = setup()
    api.completeOnboarding.mockRejectedValueOnce(new Error('Save failed'))
    await user.click(await screen.findByTestId('stand-in-onboarding-complete'))
    await screen.findByRole('alert')
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
    expect(screen.getByTestId('stand-in-onboarding-content')).toHaveAttribute('inert')
  })

  it('presents five equivalent clickable examples in a modal without starting their work', async () => {
    const { api } = setup()
    await screen.findByTestId('stand-in-onboarding-complete')
    const dialog = screen.getByRole('dialog', { name: '开始使用我的分身' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    for (const id of [
      'daily_brief',
      'meeting_prep',
      'project_followup',
      'dingtalk_reply',
      'weekly_review',
    ]) {
      expect(screen.getByTestId(`stand-in-onboarding-example-${id}`)).toBeVisible()
    }
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-onboarding-time')).not.toBeInTheDocument()
    expect(screen.getByTestId('stand-in-onboarding-content')).toHaveAttribute('inert')
    expect(api.completeOnboarding).not.toHaveBeenCalled()
  })

  it('dismisses the modal with Escape without completing setup', async () => {
    const { api, user, onClose } = setup()
    await screen.findByTestId('stand-in-onboarding-complete')
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    expect(api.completeOnboarding).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('hands an example to the conversation without submitting or scheduling work', async () => {
    const { api, user, onExampleSelect } = setup()
    const example = await screen.findByTestId('stand-in-onboarding-example-daily_brief')
    await user.click(example)
    expect(onExampleSelect).toHaveBeenCalledWith(expect.stringContaining('邮件、日历和项目动态'))
    expect(onExampleSelect).toHaveBeenCalledWith(
      '综合我的邮件、日历和项目动态，列出今天最重要的三件事，并附上来源。'
    )
    expect(api.completeOnboarding).toHaveBeenCalledWith(
      7,
      'mac',
      false,
      '09:00',
      expect.any(String)
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
