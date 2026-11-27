import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, useState } from 'react'
import { expect, test, vi } from 'vitest'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { personalStandInFixture } from './personalStandInSettings.testFixtures'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'
import type { StandInSettingsHandle } from './StandInSettingsPage'

vi.mock('./StandInConnectionSettings', () => ({
  StandInConnectionSettings: ({
    dingTalk,
  }: {
    dingTalk: {
      saved: NonNullable<PersonalStandInSettings['primary']>
      onSave(primary: NonNullable<PersonalStandInSettings['primary']>): Promise<boolean>
    }
  }) => {
    const [saved, setSaved] = useState(false)
    return (
      <div data-testid="test-connection-settings">
        <button
          data-testid="test-save-dingtalk"
          onClick={() => {
            void dingTalk
              .onSave({
                ...dingTalk.saved,
                model: { runtime: 'codex', provider: 'fixture', model_id: 'model' },
                connections: [
                  {
                    providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
                    id: 'friend',
                    name: 'Friend',
                    profile: 'org:alice',
                    kind: 'direct',
                    accountId: 'account',
                    policy: { automatic: true, askBeforeAct: false },
                  },
                ],
                delegation: {
                  version: 1,
                  authorized: false,
                  paused: true,
                  profile: 'org:alice',
                  accountId: 'account',
                  organizationId: 'org',
                  templates: { document: true, schedule: true, process: true },
                },
              })
              .then(() => setSaved(true))
          }}
        >
          Save
        </button>
        {saved && <span data-testid="test-dingtalk-saved">Saved</span>}
      </div>
    )
  },
}))

function renderProfile(error: string | null = null) {
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
  const onReload = vi.fn()
  const ref = createRef<StandInSettingsHandle>()

  const profile = (settings: PersonalStandInSettings) => (
    <AppPreferencesContext.Provider value={{ preferences: defaultAppPreferences, loaded: true }}>
      <StandInPrimaryProfile
        ref={ref}
        settings={settings}
        saving={false}
        error={error}
        onSave={onSave}
        onClose={onClose}
        onReload={onReload}
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
    onReload,
    updateSettings: (saved: PersonalStandInSettings) => view.rerender(profile(saved)),
  }
}

async function saveScopeAndReturn() {
  fireEvent.click(screen.getByTestId('stand-in-primary-connections-open'))
  fireEvent.click(await screen.findByTestId('test-save-dingtalk'))
  await screen.findByTestId('test-dingtalk-saved')
  fireEvent.click(screen.getByTestId('stand-in-primary-back-to-settings'))
}

test('closing after the DingTalk scope is accepted does not report unsaved changes', async () => {
  const { onClose } = renderProfile()
  await saveScopeAndReturn()
  fireEvent.click(screen.getByTestId('stand-in-primary-profile-close'))
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  expect(screen.queryByTestId('stand-in-primary-discard')).not.toBeInTheDocument()
})

test('saving DingTalk scope preserves unsaved primary instructions and preferences', async () => {
  const { settings, onSave, onClose, updateSettings } = renderProfile()
  fireEvent.change(screen.getByTestId('stand-in-primary-ghost-prompt'), {
    target: { value: 'Draft instructions' },
  })
  fireEvent.change(screen.getByTestId('stand-in-preferences'), {
    target: { value: 'Draft preferences' },
  })

  await saveScopeAndReturn()
  expect(onSave.mock.calls[0]?.[0].primary).toMatchObject({
    prompt: settings.primary?.prompt,
    preferences: settings.primary?.preferences,
  })
  expect(screen.getByTestId('stand-in-primary-ghost-prompt')).toHaveValue('Draft instructions')
  expect(screen.getByTestId('stand-in-preferences')).toHaveValue('Draft preferences')

  const saved = await onSave.mock.results[0].value
  updateSettings(saved)
  expect(screen.getByTestId('stand-in-preferences')).toHaveValue('Draft preferences')
  fireEvent.click(screen.getByTestId('stand-in-primary-profile-close'))
  expect(await screen.findByTestId('stand-in-primary-discard')).toBeInTheDocument()
  expect(onClose).not.toHaveBeenCalled()

  fireEvent.click(screen.getByTestId('stand-in-primary-keep-editing'))
  fireEvent.click(screen.getByTestId('stand-in-primary-save'))
  expect(onSave.mock.calls[1]?.[0]).toMatchObject({
    version: saved.version,
    primary: {
      prompt: 'Draft instructions',
      preferences: 'Draft preferences',
      delegation: saved.primary?.delegation,
      connections: saved.primary?.connections,
    },
  })
})

test('reloading after an error reconciles the primary draft only after discard confirmation', async () => {
  const { settings, onReload, updateSettings } = renderProfile('Cloud definition changed')
  fireEvent.change(screen.getByTestId('stand-in-preferences'), {
    target: { value: 'My unsaved preferences' },
  })
  fireEvent.click(screen.getByTestId('stand-in-primary-settings-retry'))
  await screen.findByTestId('stand-in-primary-discard')
  expect(onReload).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('stand-in-primary-keep-editing'))
  expect(screen.getByTestId('stand-in-preferences')).toHaveValue('My unsaved preferences')

  fireEvent.click(screen.getByTestId('stand-in-primary-settings-retry'))
  fireEvent.click(await screen.findByTestId('stand-in-primary-discard'))
  expect(onReload).toHaveBeenCalledOnce()
  updateSettings({
    ...settings,
    version: settings.version + 1,
    primary: { ...settings.primary!, prompt: 'Peer updated instructions' },
  })
  expect(screen.getByTestId('stand-in-primary-ghost-prompt')).toHaveValue(
    'Peer updated instructions'
  )
  expect(screen.getByTestId('stand-in-preferences')).toHaveValue('Saved preferences')
})
