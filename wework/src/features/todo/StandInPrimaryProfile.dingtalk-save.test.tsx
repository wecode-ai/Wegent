import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { expect, test, vi } from 'vitest'
import type { PersonalStandInSettings, StandInRole } from '@/api/personalStandIn'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { personalStandInFixture } from './personalStandInSettings.testFixtures'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'
import type { StandInSettingsHandle } from './StandInSettingsPage'

vi.mock('./StandInConnectionSettings', () => ({
  StandInConnectionSettings: ({
    role,
    onChange,
  }: {
    role: StandInRole
    onChange(next: StandInRole): void
  }) => (
    <button
      data-testid="test-select-dingtalk"
      onClick={() =>
        onChange({
          ...role,
          connections: [
            {
              providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
              id: 'friend',
              name: 'Friend',
              profile: 'org:alice',
              kind: 'direct',
              accountId: 'account',
              policy: { automatic: true, askBeforeAct: true },
            },
          ],
        })
      }
    >
      Select DingTalk
    </button>
  ),
}))

function renderProfile() {
  const { settings, services } = personalStandInFixture()
  settings.primary = {
    enabled: false,
    selfLearningEnabled: false,
    prompt: 'Saved instructions',
    preferences: 'Saved preferences',
  }
  const onSave = vi.fn(async (next: PersonalStandInSettings) => ({
    ...next,
    version: next.version + 1,
  }))
  const onClose = vi.fn()
  const ref = createRef<StandInSettingsHandle>()

  const profile = (settings: PersonalStandInSettings) => (
    <AppPreferencesContext.Provider value={{ preferences: defaultAppPreferences, loaded: true }}>
      <StandInPrimaryProfile
        ref={ref}
        settings={settings}
        saving={false}
        error={null}
        onSave={onSave}
        onClose={onClose}
        localDeviceId={settings.executionDeviceId}
        services={services}
        devices={[]}
        projects={[]}
        onSelectDevice={() => {}}
      />
    </AppPreferencesContext.Provider>
  )
  const view = render(profile(settings))
  return {
    settings,
    onSave,
    onClose,
    updateSettings: (saved: PersonalStandInSettings) => view.rerender(profile(saved)),
  }
}

async function selectScopeAndReturn() {
  fireEvent.click(screen.getByTestId('stand-in-primary-connections-open'))
  fireEvent.click(await screen.findByTestId('test-select-dingtalk'))
  fireEvent.click(screen.getByTestId('stand-in-primary-back-to-settings'))
}

test('closing after selecting a DingTalk scope asks before discarding the draft', async () => {
  const { onClose, onSave } = renderProfile()
  await selectScopeAndReturn()
  fireEvent.click(screen.getByTestId('stand-in-primary-profile-close'))
  expect(await screen.findByTestId('stand-in-primary-discard')).toBeInTheDocument()
  expect(onClose).not.toHaveBeenCalled()
  expect(onSave).not.toHaveBeenCalled()
})

test('the main save commits the DingTalk scope with edited instructions and preferences', async () => {
  const { onSave, updateSettings, onClose } = renderProfile()
  fireEvent.change(screen.getByTestId('stand-in-primary-ghost-prompt'), {
    target: { value: 'Draft instructions' },
  })
  fireEvent.change(screen.getByTestId('stand-in-preferences'), {
    target: { value: 'Draft preferences' },
  })
  await selectScopeAndReturn()
  expect(onSave).not.toHaveBeenCalled()
  expect(screen.getByTestId('stand-in-primary-ghost-prompt')).toHaveValue('Draft instructions')
  expect(screen.getByTestId('stand-in-preferences')).toHaveValue('Draft preferences')

  fireEvent.click(screen.getByTestId('stand-in-primary-save'))
  expect(onSave).toHaveBeenCalledOnce()
  expect(onSave.mock.calls[0]?.[0].primary).toMatchObject({
    prompt: 'Draft instructions',
    preferences: 'Draft preferences',
    dingTalkConnectionMode: 'confirmed',
    connections: [{ id: 'friend' }],
  })
  updateSettings(await onSave.mock.results[0].value)
  fireEvent.click(screen.getByTestId('stand-in-primary-profile-close'))
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
})
