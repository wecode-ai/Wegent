import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { runnerModelKey, type RunnerModel } from '@wegent/collaboration'
import {
  STAND_IN_DINGTALK_PROVIDER,
  type PersonalStandInSettings,
  type StandInIdentity,
} from '@/api/personalStandIn'
import { DingTalkDelegationControls } from '@/features/collaboration-exp/stand-in/DingTalkDelegationControls'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useState } from 'react'
import { personalStandInFixture } from './personalStandInSettings.testFixtures'
import { standInOverviewFixture } from './StandInOverviewPage.testFixtures'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'
import { StandInImConnections } from './StandInImConnections'

function openPrimaryProfile(
  selfLearningEnabled?: boolean,
  imSessionApi?: WorkbenchServices['imSessionApi']
) {
  const { settings } = personalStandInFixture()
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
    services.standInApi.catalog = async () => ({ models: [model] })
  }
  settings.primary = {
    enabled: true,
    selfLearningEnabled,
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
    save: () => {
      fireEvent.click(screen.getByTestId('stand-in-primary-save'))
      return onSave.mock.calls[0]?.[0].primary
    },
  }
}

test.each([true, false])(
  'DingTalk verifies exact read access before the enable action with a prepared scope: %s',
  async prepareScope => {
    const { services } = standInOverviewFixture().props
    const api = services.standInApi!
    const identity = {
      profile: 'org:alice',
      accountId: 'fixture-binding',
      accountName: 'Alice',
      organizationId: 'org',
      organizationName: 'Studio',
    }
    let permissionsGranted = false
    const checked = vi.fn()
    api.connectionReadiness = async (device, provider, profile, sources) => {
      if (sources) checked(device, provider, profile, sources)
      return {
        status: sources && !permissionsGranted ? 'permissions_required' : 'ready',
        identity,
        permissions: {
          read: sources && permissionsGranted ? 'verified' : 'unchecked',
          reply: 'unverified',
        },
      }
    }
    api.searchConnectionResources = async () => ({
      items: [
        {
          providerId: STAND_IN_DINGTALK_PROVIDER,
          id: 'friend',
          kind: 'direct',
          profile: identity.profile,
          accountId: identity.accountId,
          name: 'Friend',
        },
        {
          providerId: STAND_IN_DINGTALK_PROVIDER,
          id: 'other',
          kind: 'direct',
          profile: identity.profile,
          accountId: 'other-binding',
          name: 'Other',
        },
      ],
    })
    const save = vi.fn()
    const model = {
      runtime: 'codex' as const,
      source: 'native' as const,
      provider: 'test',
      model_id: 'model',
    }
    function TestSetup() {
      const [saved, setSaved] = useState<StandInIdentity>({
        enabled: false,
        prompt: '',
        preferences: '',
      })
      return (
        <DingTalkDelegationControls
          settings={{
            saved,
            modelSelection: { identity: model },
            primaryStopped: false,
            async onSave(next) {
              save(next)
              const delegated = next.delegation?.action === 'enable'
              setSaved({
                ...next,
                delegation: next.delegation && {
                  ...next.delegation,
                  action: undefined,
                  authorized: delegated,
                  paused: !delegated,
                },
              })
              return true
            },
          }}
          api={api}
          provider={{
            id: STAND_IN_DINGTALK_PROVIDER,
            displayName: 'DingTalk',
            resourceKinds: ['direct', 'group'],
            availability: { status: 'ready' },
            dependencies: [],
          }}
          deviceId="device"
          localDeviceId="device"
          disabled={false}
        />
      )
    }
    render(<TestSetup />)
    expect(await screen.findByTestId('stand-in-dingtalk-account')).toHaveTextContent(
      'Alice · Studio'
    )
    expect(screen.getByTestId('stand-in-delegation-enable')).toBeDisabled()
    const query = await screen.findByTestId('stand-in-dingtalk-query')
    fireEvent.change(query, { target: { value: 'Friend' } })
    fireEvent.click(screen.getByTestId('stand-in-dingtalk-search'))
    fireEvent.click(await screen.findByTestId('stand-in-dingtalk-result-friend'))
    expect(screen.queryByTestId('stand-in-dingtalk-result-other')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('stand-in-dingtalk-add-selected'))

    if (prepareScope) {
      fireEvent.click(screen.getByTestId('stand-in-dingtalk-save-scope'))
      await vi.waitFor(() => {
        expect(screen.getByTestId('stand-in-dingtalk-save-scope')).toBeDisabled()
        expect(screen.getByTestId('stand-in-delegation-enable')).toBeEnabled()
      })
      expect(save).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          enabled: false,
          connections: [expect.objectContaining({ id: 'friend', accountId: identity.accountId })],
          delegation: expect.objectContaining({ action: 'prepare', profile: identity.profile }),
        })
      )
    }
    expect(checked).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('stand-in-delegation-enable'))
    expect(await screen.findByRole('alert')).toHaveTextContent('所选会话缺少读取权限')
    expect(save).toHaveBeenCalledTimes(prepareScope ? 1 : 0)
    expect(checked).toHaveBeenCalledExactlyOnceWith(
      'device',
      STAND_IN_DINGTALK_PROVIDER,
      identity.profile,
      [{ id: 'friend', kind: 'direct' }]
    )
    permissionsGranted = true
    fireEvent.click(screen.getByTestId('stand-in-delegation-enable'))
    expect(await screen.findByTestId('stand-in-delegation-toggle-pause')).toBeEnabled()
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        delegation: expect.objectContaining({ action: 'enable', organizationId: 'org' }),
      })
    )
  }
)

test('shows DingTalk component recovery when readiness reports it unavailable', async () => {
  const { services } = standInOverviewFixture().props
  const api = services.standInApi!
  api.connectionReadiness = async () => ({
    status: 'component_unavailable',
    code: 'connection_cli_unavailable',
  })
  render(
    <DingTalkDelegationControls
      settings={{
        saved: { enabled: false, prompt: '', preferences: '' },
        modelSelection: { identity: null },
        primaryStopped: false,
        onSave: async () => true,
      }}
      api={api}
      provider={{
        id: STAND_IN_DINGTALK_PROVIDER,
        displayName: 'DingTalk',
        resourceKinds: ['direct', 'group'],
        availability: { status: 'ready' },
        dependencies: [],
      }}
      deviceId="device"
      localDeviceId="device"
      disabled={false}
    />
  )
  expect(await screen.findByTestId('stand-in-dingtalk-open-updates')).toBeEnabled()
  expect(screen.getByTestId('stand-in-delegation-enable')).toBeDisabled()
})

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
