import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { runnerModelKey, type RunnerModel } from '@wegent/collaboration'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { personalStandInFixture } from './personalStandInSettings.testFixtures'
import { standInOverviewFixture } from './StandInOverviewPage.testFixtures'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'

function openPrimaryProfile(selfLearningEnabled?: boolean) {
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

test('a model change keeps the unified instructions for a profile without learning', async () => {
  const { model, save } = openPrimaryProfile()
  expect(screen.getByTestId('stand-in-preferences')).toHaveValue(
    'Ask for evidence\n\nPrivate context'
  )
  fireEvent.click(screen.getByTestId('model-selector-button'))
  const modelOption = `model-option-${runnerModelKey(model)}`
  if (!screen.queryByTestId(modelOption)) {
    fireEvent.click(await screen.findByTestId('model-group-codex-provider:fixture'))
  }
  fireEvent.click(await screen.findByTestId(modelOption))
  expect(save()).toMatchObject({
    prompt: '',
    preferences: 'Ask for evidence\n\nPrivate context',
    model: { model_id: model.model_id },
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
