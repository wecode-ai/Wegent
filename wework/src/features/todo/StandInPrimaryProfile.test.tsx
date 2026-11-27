import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { runnerModelKey, type RunnerModel } from '@wegent/collaboration'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { personalStandInFixture } from './personalStandInSettings.testFixtures'
import { standInOverviewFixture } from './StandInOverviewPage.testFixtures'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'

function openPrimaryProfile(selfLearningEnabled?: boolean, cloudDefinitionRevision?: string) {
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

test('DingTalk personal status shows unavailability without offering an action', () => {
  openPrimaryProfile()

  const sources = within(screen.getByRole('region', { name: '知识来源' }))
  const status = sources.getByRole('status', { name: '钉钉个人状态' })
  expect(status).toBeVisible()
  expect(status).toHaveTextContent(
    '当前版本无法读取你的钉钉个人状态。基于此来源的私信自动回答已关闭。'
  )
  expect(sources.queryByRole('button')).not.toBeInTheDocument()
  expect(sources.queryByRole('link')).not.toBeInTheDocument()
  expect(sources.queryByRole('switch')).not.toBeInTheDocument()
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
