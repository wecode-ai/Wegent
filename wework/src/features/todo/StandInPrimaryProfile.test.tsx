import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { runnerModelKey, type RunnerModel } from '@wegent/collaboration'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { personalStandInFixture } from './personalStandInSettings.testFixtures'
import { standInOverviewFixture } from './StandInOverviewPage.testFixtures'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'
import { StandInImConnections } from './StandInImConnections'

function openPrimaryProfile(
  selfLearningEnabled?: boolean,
  imSessionApi?: WorkbenchServices['imSessionApi'],
  cloudDefinitionRevision?: string,
  teamRef?: string
) {
  const { settings } = personalStandInFixture()
  settings.cloudDefinitionRevision = cloudDefinitionRevision
  const { services } = standInOverviewFixture().props
  const model: RunnerModel = {
    runtime: 'codex',
    provider: 'fixture',
    model_id: 'other-model',
    local_model_id: 'other-model',
    label: 'Other model',
    account_label: 'Fixture',
    is_default: false,
  }
  if (services.standInApi) {
    if (teamRef)
      services.standInApi.personalGet = async () => ({
        ...settings,
        referencedTeamPrompt: 'Current source instructions',
      })
    services.standInApi.catalog = async () => ({ models: [model] })
  }
  settings.primary = {
    enabled: true,
    selfLearningEnabled,
    ...(teamRef ? { teamRef } : {}),
    prompt: 'Ask for evidence',
    preferences: 'Private context',
  }
  const onSave = vi
    .fn<(value: PersonalStandInSettings) => Promise<void>>()
    .mockResolvedValue(undefined)
  render(
    <AppPreferencesContext.Provider
      value={{
        preferences: { ...defaultAppPreferences, experimentalFeaturesEnabled: true },
        loaded: true,
      }}
    >
      <StandInPrimaryProfile
        settings={settings}
        saving={false}
        error={null}
        onSave={onSave}
        onClose={() => {}}
        localDeviceId={settings.executionDeviceId}
        services={services}
        devices={[]}
        projects={[]}
        onSelectDevice={() => {}}
        shortcuts={[
          {
            id: 'im',
            testId: 'stand-in-im-channels-toggle',
            label: 'Chat channels',
            content: (
              <StandInImConnections
                services={{ ...services, imSessionApi }}
                deviceId={settings.executionDeviceId}
                name="Assistant"
              />
            ),
          },
        ]}
      />
    </AppPreferencesContext.Provider>
  )
  return {
    model,
    onSave,
    save: () => {
      fireEvent.click(screen.getByTestId('stand-in-primary-save'))
      return onSave.mock.calls[0]?.[0].primary
    },
  }
}

test('a model change keeps the unified instructions for a profile without learning', async () => {
  const { model, save } = openPrimaryProfile()
  expect(screen.getByTestId('stand-in-preferences')).toHaveValue(
    'Ask for evidence\n\nPrivate context'
  )
  const environment = screen.getByTestId('stand-in-primary-execution-toggle')
  expect(screen.queryByTestId('model-selector-button')).not.toBeInTheDocument()
  fireEvent.click(environment)
  expect(screen.getByTestId('stand-in-path-advanced')).toHaveAttribute('aria-current', 'page')
  expect(screen.queryByTestId('stand-in-preferences')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('model-selector-button'))
  const modelOption = `model-option-${runnerModelKey(model)}`
  if (!screen.queryByTestId(modelOption)) {
    fireEvent.click(await screen.findByTestId('model-group-codex-provider:fixture'))
  }
  fireEvent.click(await screen.findByTestId(modelOption))
  fireEvent.click(screen.getByTestId('stand-in-primary-back-to-settings'))
  expect(screen.getByTestId('stand-in-preferences')).toBeInTheDocument()
  expect(save()).toMatchObject({
    prompt: '',
    preferences: 'Ask for evidence\n\nPrivate context',
    model: { model_id: model.model_id },
  })
})

test('saves a confirmed task permission with the primary profile', async () => {
  const user = userEvent.setup()
  const { save } = openPrimaryProfile()
  await user.click(screen.getByTestId('stand-in-primary-execution-toggle'))
  const trigger = screen.getByTestId('permission-mode-menu-button')
  expect(trigger).toHaveTextContent('只读')

  await user.click(trigger)
  await user.click(screen.getByTestId('permission-mode-full-access'))
  await user.click(screen.getByTestId('command-approval-confirm-option-ai'))
  await user.click(screen.getByTestId('full-access-confirm-submit'))
  expect(save()).toMatchObject({
    taskPermissions: { permissionMode: 'full-access', commandApproval: 'ai' },
  })
})

test('chat channels are listed directly without sessions and returning keeps the profile draft', async () => {
  const { save } = openPrimaryProfile(undefined, {
    bindStandIn: async (_sessionKey, binding) => binding,
    listPrivateSessions: async () => ({ total: 0, items: [] }),
  })
  fireEvent.change(screen.getByTestId('stand-in-preferences'), {
    target: { value: 'Edited private context' },
  })
  fireEvent.click(screen.getByTestId('stand-in-im-channels-toggle'))
  expect(screen.getByTestId('stand-in-path-tool')).toHaveTextContent('Chat channels')
  for (const channel of ['dingtalk', 'telegram', 'discord', 'weibo']) {
    expect(screen.getByTestId(`stand-in-im-channel-${channel}`)).toBeVisible()
  }
  expect(screen.queryByTestId('stand-in-im-add-channels')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-preferences')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('stand-in-im-channel-telegram'))
  expect(await screen.findByTestId('stand-in-im-empty')).toBeVisible()
  fireEvent.click(screen.getByTestId('stand-in-im-dialog-close'))
  fireEvent.click(screen.getByTestId('stand-in-primary-back-to-settings'))
  expect(screen.getByTestId('stand-in-preferences')).toHaveValue('Edited private context')
  expect(save()).toMatchObject({ preferences: 'Edited private context' })
})

test('a connected channel shows its status beside the other channel entries', async () => {
  const { settings } = personalStandInFixture()
  openPrimaryProfile(undefined, {
    bindStandIn: async (_sessionKey, binding) => binding,
    listPrivateSessions: async () => ({
      total: 1,
      items: [
        {
          session_key: 'telegram-session',
          channel_type: 'telegram',
          channel_label: 'Telegram',
          channel_id: 1,
          conversation_id: 'test-chat',
          sender_id: 'test-sender',
          display_name: 'Example conversation',
          last_seen_at: '2025-01-01T00:00:00Z',
          mode: 'stand_in',
          stand_in: { deviceId: settings.executionDeviceId, roleId: null },
        },
      ],
    }),
  })
  fireEvent.click(screen.getByTestId('stand-in-im-channels-toggle'))
  expect(await screen.findByText('已连接当前助理')).toBeVisible()
  expect(screen.getByTestId('stand-in-im-channel-dingtalk')).toBeVisible()
  fireEvent.click(screen.getByTestId('stand-in-im-channel-telegram'))
  expect(screen.getByTestId('stand-in-im-connect-telegram-session')).toHaveTextContent(
    'Example conversation'
  )
})

test('turning on learning alone preserves the existing Ghost and private preferences', () => {
  const { save } = openPrimaryProfile()
  fireEvent.click(screen.getByTestId('stand-in-self-learning-toggle'))
  expect(save()).toMatchObject({
    selfLearningEnabled: true,
    prompt: 'Ask for evidence',
    preferences: 'Private context',
  })
})

test('editing private preferences preserves the independently learned Ghost, including after learning is disabled', () => {
  const { save } = openPrimaryProfile(false)
  expect(screen.getByTestId('stand-in-primary-ghost-prompt')).toHaveValue('Ask for evidence')
  const preferences = screen.getByTestId('stand-in-preferences')
  expect(preferences).toHaveValue('Private context')
  fireEvent.change(preferences, { target: { value: 'Edited private context' } })
  expect(save()).toMatchObject({
    prompt: 'Ask for evidence',
    preferences: 'Edited private context',
  })
})

test('a migrated default assistant keeps its shared instructions when private preferences change', () => {
  const { save } = openPrimaryProfile(undefined, undefined, 'cloud-revision')
  expect(screen.getByTestId('stand-in-primary-ghost-prompt')).toHaveValue('Ask for evidence')
  fireEvent.change(screen.getByTestId('stand-in-preferences'), {
    target: { value: 'Edited private context' },
  })
  expect(save()).toMatchObject({
    prompt: 'Ask for evidence',
    preferences: 'Edited private context',
  })
})

test('saving edits to a referenced Team requires explicit copy confirmation', async () => {
  const { save, onSave } = openPrimaryProfile(undefined, undefined, undefined, 'LA-original')
  const editor = await screen.findByDisplayValue('Current source instructions')
  fireEvent.change(editor, {
    target: { value: 'New instructions' },
  })
  save()
  fireEvent.click(screen.getByTestId('stand-in-copy-team-cancel'))
  expect(onSave).not.toHaveBeenCalled()
  save()
  fireEvent.click(screen.getByTestId('stand-in-copy-team-confirm'))
  expect(onSave).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      primary: expect.objectContaining({ teamRef: 'LA-original', prompt: 'New instructions' }),
    }),
    false,
    true
  )
})
