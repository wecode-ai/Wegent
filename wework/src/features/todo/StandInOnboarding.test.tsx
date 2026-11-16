import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { StandInExecutorApi } from '@/api/standIn'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { StandInOnboarding } from './StandInOnboarding'

/** Builds account-scoped setup fixtures while retaining the real connection editor. */
function setup(
  completed = false,
  guideOpen = false,
  primary?: PersonalStandInSettings['primary'],
  pending?: Promise<{ state: { version: number; completed: boolean } }>
) {
  const settings: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'mac',
    version: 1,
    roles: [],
    primary,
  }
  const api = {
    onboarding: vi.fn(async () => pending ?? { state: { version: 1, completed } }),
    completeOnboarding: vi.fn(async () => ({ state: { version: 1, completed: true } })),
    connectionProviders: vi.fn(async () => ({ items: [] })),
  }
  const onSave = vi.fn(async (value: PersonalStandInSettings) => ({
    ...value,
    version: value.version + 1,
  }))
  const configuration = {
    settings,
    projects: [],
    localDeviceId: 'mac',
    loading: false,
    error: null,
    onSave,
    onReload: vi.fn(),
  }
  const onClose = vi.fn()
  const onExampleSelect = vi.fn()
  const view = render(
    <StandInOnboarding
      api={api as unknown as StandInExecutorApi}
      userId={7}
      deviceId="mac"
      configuration={configuration}
      guideOpen={guideOpen}
      onClose={onClose}
      onExampleSelect={onExampleSelect}
    >
      <p>Stand-in content</p>
    </StandInOnboarding>
  )
  return { ...view, api, configuration, onClose, onExampleSelect, onSave, user: userEvent.setup() }
}
async function continueSetup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('stand-in-onboarding-continue'))
}

describe('stand-in onboarding', () => {
  it.each([true, false])(
    'waits for completion state before opening automatic onboarding (%s)',
    async completed => {
      let finish!: (value: { state: { version: number; completed: boolean } }) => void
      setup(
        completed,
        false,
        undefined,
        new Promise(resolve => {
          finish = resolve
        })
      )
      expect(screen.getByRole('status')).toHaveTextContent('正在读取助理功能设置')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByTestId('stand-in-onboarding-content')).not.toHaveAttribute('inert')

      await act(async () => finish({ state: { version: 1, completed } }))

      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      if (completed) {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.getByText('Stand-in content')).toBeVisible()
      } else {
        expect(screen.getByRole('dialog')).toBeVisible()
        expect(screen.getByTestId('stand-in-onboarding-content')).toHaveAttribute('inert')
      }
    }
  )

  it('shows loading failures and allows retrying the completion check', async () => {
    const { api, user } = setup(false, false, undefined, Promise.reject(new Error('Read failed')))
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法完成此操作')
    api.onboarding.mockResolvedValueOnce({ state: { version: 1, completed: true } })
    await user.click(screen.getByTestId('stand-in-onboarding-retry'))
    expect(await screen.findByText('Stand-in content')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens an explicitly requested guide while its settings are loading', () => {
    setup(true, true, undefined, new Promise(() => {}))
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('正在读取助理功能设置')
  })

  it('uses the connection catalog first and allows continuing without selecting any apps', async () => {
    const { api, onSave, user } = setup()
    expect(await screen.findByTestId('stand-in-connection-type-picker')).toBeVisible()
    expect(screen.queryByTestId('stand-in-onboarding-example-daily_brief')).not.toBeInTheDocument()
    expect(screen.getByTestId('stand-in-onboarding-continue')).toBeEnabled()
    await continueSetup(user)
    expect(screen.getByTestId('stand-in-onboarding-summary')).toHaveTextContent('还没有连接应用')
    expect(onSave).not.toHaveBeenCalled()
    expect(api.completeOnboarding).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByText('Stand-in content')
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        primary: expect.objectContaining({
          enabled: true,
          collaboration: expect.objectContaining({ enabled: false, allProjects: false }),
        }),
      })
    )
    expect(api.completeOnboarding).toHaveBeenCalledWith(
      7,
      'mac',
      false,
      '09:00',
      expect.any(String)
    )
  })
  it('keeps project connection changes as drafts until final confirmation and preserves them on back', async () => {
    const { user, onSave, api } = setup()
    await user.click(await screen.findByTestId('stand-in-add-projects-connection'))
    await user.click(screen.getByTestId('stand-in-source-collaboration'))
    await user.click(screen.getByTestId('stand-in-all-projects'))
    await continueSetup(user)
    expect(screen.getByTestId('stand-in-onboarding-summary')).toHaveTextContent('所有我参与的项目')
    expect(onSave).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-onboarding-back'))
    await user.click(await screen.findByTestId('stand-in-add-projects-connection'))
    expect(screen.getByTestId('stand-in-source-collaboration')).toBeChecked()
    expect(screen.getByTestId('stand-in-all-projects')).toBeChecked()
    await continueSetup(user)
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByText('Stand-in content')
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        primary: expect.objectContaining({
          enabled: true,
          collaboration: expect.objectContaining({
            enabled: true,
            allProjects: true,
            policy: { automatic: true, askBeforeAct: true, immediate: false },
          }),
        }),
      })
    )
    expect(onSave.mock.invocationCallOrder[0]).toBeLessThan(
      api.completeOnboarding.mock.invocationCallOrder[0]
    )
  })
  it('shows progress and prevents closing or duplicate submissions while saving', async () => {
    const { api, user } = setup()
    let finish!: () => void
    api.completeOnboarding.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ state: { version: 1, completed: true } })
        })
    )
    await continueSetup(user)
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    expect(screen.getByTestId('stand-in-onboarding-complete')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByTestId('stand-in-onboarding-close')).toBeDisabled()
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    expect(api.completeOnboarding).toHaveBeenCalledOnce()
    await act(async () => finish())
    await screen.findByText('Stand-in content')
  })
  it('closing does not submit or complete onboarding', async () => {
    const { api, onClose, onSave, user } = setup()
    await screen.findByTestId('stand-in-onboarding-continue')
    await user.click(screen.getByTestId('stand-in-onboarding-close'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(api.completeOnboarding).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('protects changed connection drafts when closing', async () => {
    const { user, onSave } = setup()
    await user.click(await screen.findByTestId('stand-in-add-projects-connection'))
    await user.click(screen.getByTestId('stand-in-source-collaboration'))
    await user.click(screen.getByTestId('stand-in-onboarding-close'))
    await user.click(screen.getByTestId('stand-in-onboarding-keep-editing'))
    expect(screen.getByTestId('stand-in-source-collaboration')).toBeChecked()
    await user.click(screen.getByTestId('stand-in-onboarding-close'))
    await user.click(screen.getByTestId('stand-in-onboarding-discard'))
    expect(screen.queryByTestId('stand-in-onboarding')).not.toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })
  it('retains drafts after save failure without completing onboarding', async () => {
    const { api, user, onSave } = setup()
    onSave.mockRejectedValueOnce(new Error('Save failed'))
    await continueSetup(user)
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByRole('alert')
    expect(api.completeOnboarding).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByText('Stand-in content')
  })
  it('retries completion without saving the same settings again', async () => {
    const { api, user, onSave } = setup()
    api.completeOnboarding.mockRejectedValueOnce(new Error('Save failed'))
    await continueSetup(user)
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByRole('alert')
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByText('Stand-in content')
    expect(onSave).toHaveBeenCalledOnce()
  })
  it('does not show onboarding or fetch the catalog after completion', async () => {
    const { api } = setup(true)
    await screen.findByText('Stand-in content')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.connectionProviders).not.toHaveBeenCalled()
  })
  it('ignores a late response from a different device', async () => {
    const { api, rerender, configuration } = setup(true)
    await screen.findByText('Stand-in content')
    api.onboarding.mockImplementationOnce(() => new Promise(() => {}))
    rerender(
      <StandInOnboarding
        key="other"
        api={api as unknown as StandInExecutorApi}
        userId={7}
        deviceId="other"
        configuration={{ ...configuration, settings: null, loading: true }}
      >
        <p>Other device</p>
      </StandInOnboarding>
    )
    await waitFor(() => expect(api.onboarding).toHaveBeenCalledWith(7, 'other', expect.any(String)))
    expect(screen.queryByText('Stand-in content')).not.toBeInTheDocument()
    expect(screen.getByTestId('stand-in-onboarding-content')).not.toHaveAttribute('inert')
  })
  it('dismisses the modal with Escape without completing setup', async () => {
    const { api, user, onClose } = setup()
    await screen.findByTestId('stand-in-onboarding-continue')
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    expect(api.completeOnboarding).not.toHaveBeenCalled()
  })
  it('keeps all five examples available from the help entry without changing configuration', async () => {
    const { api, user, onExampleSelect, onSave } = setup(true, true)
    for (const id of [
      'daily_brief',
      'meeting_prep',
      'project_followup',
      'dingtalk_reply',
      'weekly_review',
    ])
      expect(await screen.findByTestId(`stand-in-onboarding-example-${id}`)).toBeVisible()
    expect(screen.queryByTestId('stand-in-onboarding-complete')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-onboarding-continue')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-onboarding-example-daily_brief'))
    expect(onExampleSelect).toHaveBeenCalledWith(
      '综合我的邮件、日历和项目动态，列出今天最重要的三件事，并附上来源。'
    )
    expect(api.completeOnboarding).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })
  it('preserves saved identity preferences and host-normalized connections across completion retry', async () => {
    const primary = {
      enabled: false,
      prompt: 'Keep my instructions',
      preferences: 'Keep my preferences',
      connections: [
        {
          providerId: 'mail',
          id: 'inbox',
          profile: 'work',
          kind: 'mailbox',
          name: 'Work inbox',
          policy: { automatic: true, askBeforeAct: true, immediate: false },
        },
      ],
    }
    const { api, user, onSave } = setup(false, false, primary)
    onSave.mockImplementationOnce(async value => ({
      ...value,
      version: 2,
      primary: {
        ...value.primary!,
        connections: value.primary!.connections!.map(source => ({
          ...source,
          boundary: { partition: 'mail', sequence: 42 },
        })),
      },
    }))
    api.completeOnboarding.mockRejectedValueOnce(new Error('Completion unavailable'))
    await continueSetup(user)
    expect(screen.getByTestId('stand-in-onboarding-summary')).toHaveTextContent('Work inbox')
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByRole('alert')
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByText('Stand-in content')
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0][0].primary).toMatchObject({ ...primary, enabled: true })
  })
  it('allows continuing when the optional app catalog fails to load', async () => {
    const { api, user, onSave } = setup()
    api.connectionProviders.mockRejectedValueOnce(new Error('Catalog unavailable'))
    await screen.findByTestId('stand-in-connections-retry')
    await continueSetup(user)
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    await screen.findByText('Stand-in content')
    expect(onSave).toHaveBeenCalledOnce()
  })
})
