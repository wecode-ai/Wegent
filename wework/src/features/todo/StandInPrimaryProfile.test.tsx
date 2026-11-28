import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { expect, test, vi } from 'vitest'
import { runnerModelKey, type RunnerModel } from '@wegent/collaboration'
import {
  newStandInPrimaryRole,
  newStandInRole,
  type PersonalStandInSettings,
} from '@/api/personalStandIn'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { AuthContext, type AuthContextValue } from '@/features/auth/useAuth'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { personalStandInFixture } from './personalStandInSettings.testFixtures'
import { standInOverviewFixture } from './StandInOverviewPage.testFixtures'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'
import { StandInSettingsPage } from './StandInSettingsPage'
import type { StandInSettingsHandle } from './StandInSettingsPage'

function openPrimaryProfile(
  selfLearningEnabled?: boolean,
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

async function enterUnfinishedProjectTag(connectionEntry: string) {
  fireEvent.click(screen.getByTestId(connectionEntry))
  fireEvent.click(await screen.findByTestId('stand-in-add-projects-connection'))
  fireEvent.click(screen.getByTestId('stand-in-project-open-scope-projects'))
  fireEvent.click(screen.getByTestId('stand-in-source-tags-toggle'))
  fireEvent.change(screen.getByTestId('stand-in-connection-tags-input'), {
    target: { value: 'x'.repeat(33) },
  })
  expect(await screen.findByTestId('stand-in-project-tags-draft-help')).toBeVisible()
}

test('retrying settings requires discarding the profile draft separately from an unfinished project tag', async () => {
  const { settings, services } = personalStandInFixture()
  settings.primary = {
    enabled: true,
    prompt: '',
    preferences: 'Saved preferences',
    collaboration: {
      ...newStandInPrimaryRole(settings.executionDeviceId).collaboration,
      enabled: true,
      allProjects: true,
    },
  }
  const onReload = vi.fn()
  render(
    <StandInPrimaryProfile
      settings={settings}
      saving={false}
      error="Cloud definition changed"
      onSave={vi.fn()}
      onReload={onReload}
      onClose={vi.fn()}
      localDeviceId={settings.executionDeviceId}
      services={services}
      devices={[]}
      projects={[]}
      onSelectDevice={() => {}}
    />
  )
  fireEvent.change(screen.getByTestId('stand-in-preferences'), {
    target: { value: 'Unsaved preferences' },
  })
  await enterUnfinishedProjectTag('stand-in-primary-connections-open')

  fireEvent.click(screen.getByTestId('stand-in-primary-settings-retry'))
  fireEvent.click(await screen.findByTestId('stand-in-project-tags-discard'))
  expect(onReload).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByTestId('stand-in-primary-keep-editing'))
  expect(onReload).not.toHaveBeenCalled()

  fireEvent.click(screen.getByTestId('stand-in-primary-settings-retry'))
  fireEvent.click(await screen.findByTestId('stand-in-primary-discard'))
  expect(onReload).toHaveBeenCalledOnce()

  fireEvent.change(screen.getByTestId('stand-in-connection-tags-input'), {
    target: { value: 'y'.repeat(33) },
  })
  expect(await screen.findByTestId('stand-in-project-tags-draft-help')).toBeVisible()
  fireEvent.click(screen.getByTestId('stand-in-primary-settings-retry'))
  fireEvent.click(await screen.findByTestId('stand-in-project-tags-discard'))
  expect(onReload).toHaveBeenCalledTimes(2)
  expect(screen.queryByTestId('stand-in-primary-discard')).not.toBeInTheDocument()
})

test('creating an assistant has no instance stop action', async () => {
  const { props } = standInOverviewFixture([newStandInRole('device', 'existing')])
  render(
    <StandInSettingsPage
      {...props}
      initialCreate
      initialDeviceId="device"
      footerLeading={<button>Stop assistant</button>}
    />
  )
  expect(await screen.findByTestId('stand-in-create-team')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Stop assistant' })).toBeNull()
})

test('closing role settings confirms unsaved role changes after discarding an unfinished project tag', async () => {
  const role = newStandInRole('device', 'default')
  const { props } = standInOverviewFixture([
    {
      ...role,
      name: 'Saved role',
      enabled: true,
      collaboration: { ...role.collaboration, enabled: true },
    },
  ])
  const onCancel = vi.fn()
  render(
    <StandInSettingsPage
      {...props}
      initialProfileId={role.id}
      initialDeviceId={role.executionDeviceId}
      footerLeading={<button>Stop assistant</button>}
      onCancel={onCancel}
    />
  )
  fireEvent.change(await screen.findByTestId('stand-in-role-name'), {
    target: { value: 'Unsaved role' },
  })
  expect(screen.getByRole('button', { name: 'Stop assistant' })).toBeVisible()
  await enterUnfinishedProjectTag('stand-in-connections-open')

  fireEvent.click(screen.getByTestId('stand-in-close'))
  fireEvent.click(await screen.findByTestId('stand-in-project-tags-discard'))
  expect(onCancel).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByTestId('stand-in-keep-editing'))
  expect(onCancel).not.toHaveBeenCalled()

  fireEvent.click(screen.getByTestId('stand-in-close'))
  fireEvent.click(await screen.findByTestId('stand-in-discard'))
  expect(onCancel).toHaveBeenCalledOnce()
})

test('keeps a schedule draft within its device scope and clears its editor after a device change', async () => {
  const { settings, services } = personalStandInFixture()
  settings.primary = { enabled: true, prompt: '', preferences: 'Saved preferences' }
  const ref = createRef<StandInSettingsHandle>()
  const switchDevice = vi.fn()
  const onSave = vi.fn()
  const workbench = {
    state: { user: null, devices: [], projects: [], currentRuntimeTask: null },
    projectChat: { models: [], selectedModel: null, selectedModelOptions: {} },
    services: {
      ...services,
      automationApi: { listAutomations: vi.fn(async () => ({ items: [] })) },
    },
  } as unknown as WorkbenchContextValue
  const auth = { user: null, logout: vi.fn() } as unknown as AuthContextValue
  const profile = (value: PersonalStandInSettings) => (
    <AuthContext.Provider value={auth}>
      <WorkbenchContext.Provider value={workbench}>
        <StandInPrimaryProfile
          ref={ref}
          settings={value}
          saving={false}
          error={null}
          onSave={onSave}
          onClose={vi.fn()}
          initialCalendar
          localDeviceId={settings.executionDeviceId}
          services={services}
          devices={[]}
          projects={[]}
          onSelectDevice={switchDevice}
        />
      </WorkbenchContext.Provider>
    </AuthContext.Provider>
  )
  const view = render(profile(settings))
  fireEvent.click(await screen.findByTestId('create-automation-button'))
  fireEvent.change(await screen.findByTestId('automation-name-input'), {
    target: { value: 'Unsaved schedule' },
  })
  expect(screen.queryByTestId('stand-in-primary-save')).not.toBeInTheDocument()

  view.rerender(profile({ ...settings, version: 2 }))
  expect(screen.getByTestId('automation-name-input')).toHaveValue('Unsaved schedule')
  act(() => ref.current?.requestLeave(() => switchDevice('new-device')))
  fireEvent.click(await screen.findByTestId('automation-keep-editing'))
  expect(switchDevice).not.toHaveBeenCalled()
  expect(screen.getByTestId('automation-name-input')).toHaveValue('Unsaved schedule')

  act(() => ref.current?.requestLeave(() => switchDevice('new-device')))
  fireEvent.click(await screen.findByTestId('automation-discard'))
  expect(switchDevice).toHaveBeenCalledExactlyOnceWith('new-device')
  fireEvent.click(await screen.findByTestId('create-automation-button'))
  expect(await screen.findByTestId('automation-name-input')).toBeVisible()

  view.rerender(profile({ ...settings, version: 3, executionDeviceId: 'new-device' }))
  expect(screen.queryByTestId('automation-name-input')).not.toBeInTheDocument()
  expect(await screen.findByTestId('create-automation-button')).toBeVisible()
  expect(screen.getByTestId('stand-in-primary-save')).toBeDisabled()
  fireEvent.click(screen.getByTestId('stand-in-connections-back'))
  fireEvent.click(screen.getByTestId('stand-in-primary-back-to-settings'))
  fireEvent.change(screen.getByTestId('stand-in-preferences'), {
    target: { value: 'New device preferences' },
  })
  expect(screen.getByTestId('stand-in-primary-save')).toBeEnabled()
  expect(onSave).not.toHaveBeenCalled()
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
  const { save } = openPrimaryProfile(undefined, 'cloud-revision')
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
  const { save, onSave } = openPrimaryProfile(undefined, undefined, 'LA-original')
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
