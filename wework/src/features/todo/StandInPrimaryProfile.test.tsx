import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { personalStandInFixture } from './personalStandInSettings.testFixtures'
import { standInOverviewFixture } from './StandInOverviewPage.testFixtures'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'

test('editing private preferences preserves the independently learned Ghost, including after learning is disabled', () => {
  const { settings } = personalStandInFixture()
  const { services } = standInOverviewFixture().props
  settings.primary = {
    enabled: true,
    selfLearningEnabled: false,
    prompt: 'Ask for evidence',
    preferences: 'Private context',
  }
  const onSave = vi
    .fn<(value: PersonalStandInSettings) => Promise<void>>()
    .mockResolvedValue(undefined)
  render(
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
  )
  expect(screen.getByTestId('stand-in-primary-ghost-prompt')).toHaveValue('Ask for evidence')
  const preferences = screen.getByTestId('stand-in-preferences')
  expect(preferences).toHaveValue('Private context')
  fireEvent.change(preferences, { target: { value: 'Edited private context' } })
  fireEvent.click(screen.getByTestId('stand-in-primary-save'))
  expect(onSave.mock.calls[0]?.[0].primary).toMatchObject({
    prompt: 'Ask for evidence',
    preferences: 'Edited private context',
  })
})
