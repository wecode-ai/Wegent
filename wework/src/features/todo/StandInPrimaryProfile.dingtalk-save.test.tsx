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
                enabled: false,
                prompt: '',
                preferences: '',
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

test('closing after the DingTalk scope is accepted does not report unsaved changes', async () => {
  const { settings, services } = personalStandInFixture()
  settings.primary = {
    enabled: false,
    prompt: '',
    preferences: '',
  }
  const onSave = vi.fn(async (next: PersonalStandInSettings) => ({
    ...next,
    version: next.version + 1,
  }))
  const onClose = vi.fn()
  const ref = createRef<StandInSettingsHandle>()

  render(
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

  fireEvent.click(screen.getByTestId('stand-in-primary-connections-open'))
  fireEvent.click(await screen.findByTestId('test-save-dingtalk'))
  await screen.findByTestId('test-dingtalk-saved')

  fireEvent.click(screen.getByTestId('stand-in-primary-profile-close'))
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  expect(screen.queryByTestId('stand-in-primary-discard')).not.toBeInTheDocument()
})
