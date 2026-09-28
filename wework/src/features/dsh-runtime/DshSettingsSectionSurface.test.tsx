import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { DshSettingsSectionSurface } from './DshSettingsSectionSurface'
import { WEWORK_DSH_SLOTS } from './dshUiSlots'

const experimentalFeatures = vi.hoisted(() => ({ enabled: false }))

vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))

vi.mock('./DshContributionSlotSurface', () => ({
  DshContributionSlotSurface: ({ entryId }: { entryId: string }) => (
    <div data-testid={`settings-section-${entryId}`} />
  ),
}))

describe('DshSettingsSectionSurface', () => {
  afterEach(() => {
    delete window.__WEWORK_DSH_UI__
    experimentalFeatures.enabled = false
  })

  test('renders only sections contributed to the requested settings page', () => {
    const sections = [
      { id: 'cloud-sync', page: 'connections' },
      { id: 'unrelated', page: 'general' },
    ]
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot => (slot === WEWORK_DSH_SLOTS.settingsSection ? sections : []),
      subscribe: () => () => {},
      attach: () => ({ update: () => {}, dispose: () => {} }),
    }

    render(<DshSettingsSectionSurface page="connections" />)

    expect(screen.getByTestId('settings-section-cloud-sync')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-section-unrelated')).not.toBeInTheDocument()
  })

  test('reveals experimental sections only after experimental features are enabled', () => {
    const sections = [
      { id: 'standard', page: 'connections' },
      { experimental: true, id: 'cloud-sync', page: 'connections' },
    ]
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot => (slot === WEWORK_DSH_SLOTS.settingsSection ? sections : []),
      subscribe: () => () => {},
      attach: () => ({ update: () => {}, dispose: () => {} }),
    }

    const { rerender } = render(<DshSettingsSectionSurface page="connections" />)

    expect(screen.getByTestId('settings-section-standard')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-section-cloud-sync')).not.toBeInTheDocument()

    experimentalFeatures.enabled = true
    rerender(<DshSettingsSectionSurface page="connections" />)

    expect(screen.getByTestId('settings-section-cloud-sync')).toBeInTheDocument()
  })
})
