import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { RunnerModelIdentity } from '@wegent/collaboration'
import type { StandInExecutorApi } from '@/api/standIn'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { StandInOnboardingSetup } from './StandInOnboardingSetup'

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
  StandInConnectionSettings: () => null,
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
