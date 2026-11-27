import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useImperativeHandle, type ComponentProps } from 'react'
import { expect, test, vi } from 'vitest'
import type { RunnerModelIdentity } from '@wegent/collaboration'
import type { StandInExecutorApi } from '@/api/standIn'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { StandInOnboarding } from './StandInOnboarding'
import { StandInOnboardingSetup } from './StandInOnboardingSetup'
import type { StandInConnectionSettings } from './StandInConnectionSettings'

const modelState = vi.hoisted(() => ({
  nativeError: null as string | null,
  resolved: null as RunnerModelIdentity | null,
}))

vi.mock('./useStandInModels', () => ({
  useStandInModels: () => ({
    selectedModel: null,
    models: [],
    loading: true,
    error: modelState.nativeError,
    errors: { native: modelState.nativeError, cloud: null },
    resolve: () => modelState.resolved,
  }),
}))

vi.mock('@/components/chat/composer/ModelSelector', () => ({
  ModelSelector: () => null,
}))

vi.mock('./StandInConnectionSettings', () => ({
  StandInConnectionSettings: ({
    role,
    onChange,
    onDetailTitleChange,
    onScheduleDirtyChange,
    ref,
  }: ComponentProps<typeof StandInConnectionSettings>) => {
    useImperativeHandle(ref, () => ({
      requestLeave: action => action(false),
      back: () => onDetailTitleChange?.(null, null, null),
      returnToScopeList: () => onDetailTitleChange?.('Projects', 'projects', null),
    }))
    return (
      <>
        <button
          type="button"
          onClick={() => {
            onDetailTitleChange?.('Projects', 'projects', 'All projects')
            onChange({
              ...role,
              collaboration: { ...role.collaboration, enabled: true, allProjects: true },
            })
          }}
        >
          Add project scope
        </button>
        <button
          type="button"
          onClick={() => {
            onDetailTitleChange?.('GitHub', 'github', 'Personal events')
            onChange({
              ...role,
              connections: [
                {
                  providerId: 'github',
                  id: 'personal',
                  kind: 'personal',
                  profile: 'account',
                  name: 'Account',
                  policy: { automatic: true, askBeforeAct: true },
                },
              ],
            })
          }}
        >
          Add GitHub scope
        </button>
        <button type="button" onClick={() => onDetailTitleChange?.(null, null, null)}>
          Return to setup
        </button>
        <button type="button" onClick={() => onScheduleDirtyChange?.(true)}>
          Open unfinished editor
        </button>
        <button type="button" onClick={() => onScheduleDirtyChange?.(false)}>
          Close unfinished editor
        </button>
      </>
    )
  },
}))

test('requires a resolved model before starting a conversation', async () => {
  modelState.nativeError = 'Model catalog timed out'
  const onSelectDevice = vi.fn(async () => {})
  const onSave = vi.fn()
  const onComplete = vi.fn(async () => true)
  render(
    <StandInOnboardingSetup
      configuration={{
        settings: { userId: 7, version: 0, executionDeviceId: 'cloud', roles: [] },
        loading: false,
        error: null,
        projects: [],
        localDeviceId: 'local',
        devices: [
          {
            id: 1,
            device_id: 'cloud',
            name: 'Cloud host',
            status: 'online',
            is_default: true,
            device_type: 'cloud',
            bind_shell: 'claudecode',
          },
          {
            id: 2,
            device_id: 'remote',
            name: 'Remote host',
            status: 'online',
            is_default: false,
            device_type: 'remote',
            bind_shell: 'claudecode',
          },
        ],
        onReload: vi.fn(),
        executionDeviceId: 'cloud',
        onSelectDevice,
        onSave,
      }}
      api={{} as StandInExecutorApi}
      onComplete={onComplete}
      onBusyChange={vi.fn()}
    />
  )

  const start = screen.getByTestId('stand-in-onboarding-complete')
  expect(start).toBeDisabled()
  await act(async () => {
    fireEvent.click(start)
  })
  expect(onComplete).not.toHaveBeenCalled()
  expect(onSave).not.toHaveBeenCalled()

  const user = userEvent.setup()
  await user.click(screen.getByTestId('stand-in-onboarding-device'))
  await user.click(await screen.findByRole('option', { name: 'Remote host' }))
  expect(onSelectDevice).toHaveBeenCalledExactlyOnceWith('remote')
  expect(onComplete).not.toHaveBeenCalled()
})

test('retries completion without saving the accepted settings a second time', async () => {
  modelState.nativeError = null
  modelState.resolved = { runtime: 'codex', provider: 'test', model_id: 'test-model' }
  const onSave = vi.fn(async (settings: PersonalStandInSettings) => {
    const primary = settings.primary
    expect(primary).toBeDefined()
    expect(primary).not.toHaveProperty('modelOptions')
    return { ...settings, version: settings.version + 1 }
  })
  const onComplete = vi.fn(async () => true).mockResolvedValueOnce(false)
  const user = userEvent.setup()
  try {
    render(
      <StandInOnboardingSetup
        configuration={{
          settings: { userId: 7, version: 0, executionDeviceId: 'local', roles: [] },
          loading: false,
          error: null,
          projects: [],
          localDeviceId: 'local',
          onReload: vi.fn(),
          onSave,
        }}
        api={{} as StandInExecutorApi}
        onComplete={onComplete}
        onBusyChange={vi.fn()}
      />
    )
    const start = screen.getByTestId('stand-in-onboarding-complete')
    await user.click(start)
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(start).toBeEnabled())
    await user.click(start)
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2))
    expect(onSave).toHaveBeenCalledTimes(1)
  } finally {
    modelState.resolved = null
  }
})

test('saves only the selected connection without completing onboarding', async () => {
  modelState.nativeError = null
  modelState.resolved = null
  const onSave = vi.fn(async (settings: PersonalStandInSettings) => ({
    ...settings,
    version: settings.version + 1,
  }))
  const onComplete = vi.fn(async () => true)
  const user = userEvent.setup()
  render(
    <StandInOnboardingSetup
      configuration={{
        settings: { userId: 7, version: 0, executionDeviceId: 'local', roles: [] },
        loading: false,
        error: null,
        projects: [],
        localDeviceId: 'local',
        onReload: vi.fn(),
        onSave,
      }}
      api={{} as StandInExecutorApi}
      onComplete={onComplete}
      onBusyChange={vi.fn()}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Add GitHub scope' }))
  await user.click(screen.getByRole('button', { name: 'Add project scope' }))
  expect(screen.queryByTestId('stand-in-onboarding-complete')).not.toBeInTheDocument()
  const save = screen.getByTestId('stand-in-onboarding-save-connections')
  await user.click(screen.getByRole('button', { name: 'Open unfinished editor' }))
  expect(save).toBeDisabled()
  expect(onSave).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Close unfinished editor' }))
  await user.click(save)
  await waitFor(() => expect(save).not.toBeInTheDocument())
  expect(onSave).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      primary: expect.objectContaining({
        enabled: false,
        collaboration: expect.objectContaining({ enabled: true, allProjects: true }),
      }),
    })
  )
  const saved = onSave.mock.calls[0]?.[0].primary
  expect(saved).not.toHaveProperty('model')
  expect(saved?.connections ?? []).toEqual([])
  expect(onComplete).not.toHaveBeenCalled()

  modelState.resolved = { runtime: 'codex', provider: 'test', model_id: 'test-model' }
  try {
    await user.click(screen.getByRole('button', { name: 'Return to setup' }))
    await user.click(screen.getByTestId('stand-in-onboarding-complete'))
    const discard = screen.getByTestId('stand-in-onboarding-discard')
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onComplete).not.toHaveBeenCalled()
    await user.click(discard)
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onSave.mock.calls[1]?.[0].primary?.connections ?? []).toEqual([])
    expect(onSave.mock.calls[1]?.[0].primary?.collaboration).toEqual(saved?.collaboration)
  } finally {
    modelState.resolved = null
  }
})

test('defers setup in the assistant workspace and reopens it without saving', async () => {
  modelState.resolved = null
  const onClose = vi.fn()
  const onSave = vi.fn()
  const completeOnboarding = vi.fn()
  const user = userEvent.setup()
  render(
    <StandInOnboarding
      api={
        {
          onboarding: vi.fn(async () => ({ state: { version: 1, completed: false } })),
          completeOnboarding,
        } as unknown as StandInExecutorApi
      }
      userId={7}
      deviceId="local"
      onClose={onClose}
      onOpenConversation={vi.fn()}
      configuration={{
        settings: { userId: 7, version: 0, executionDeviceId: 'local', roles: [] },
        loading: false,
        error: null,
        projects: [],
        localDeviceId: 'local',
        onReload: vi.fn(),
        onSave,
      }}
    >
      {resumeSetup => <main>{resumeSetup}</main>}
    </StandInOnboarding>
  )
  await user.click(await screen.findByTestId('stand-in-onboarding-close'))
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.queryByTestId('stand-in-onboarding')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-onboarding-resume'))
  expect(await screen.findByTestId('stand-in-onboarding-complete')).toBeDisabled()
  expect(onSave).not.toHaveBeenCalled()
  expect(completeOnboarding).not.toHaveBeenCalled()
})
