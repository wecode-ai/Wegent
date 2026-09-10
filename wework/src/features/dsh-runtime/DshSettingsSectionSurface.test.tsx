import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { DshSettingsSectionSurface } from './DshSettingsSectionSurface'
import { WEWORK_DSH_SLOTS } from './dshUiSlots'

vi.mock('./DshContributionSlotSurface', () => ({
  DshContributionSlotSurface: ({ entryId }: { entryId: string }) => (
    <div data-testid={`settings-section-${entryId}`} />
  ),
}))

describe('DshSettingsSectionSurface', () => {
  afterEach(() => {
    delete window.__WEWORK_DSH_UI__
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
})
