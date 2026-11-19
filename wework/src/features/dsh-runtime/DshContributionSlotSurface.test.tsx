import { act, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { DshContributionSlotSurface } from './DshContributionSlotSurface'
import { getLoadedDshUiModule, importDshUiModule } from './dshUiModules'
import { WEWORK_DSH_SLOTS } from './dshUiSlots'

const source = vi.hoisted(() => ({ entries: [{ id: 'view', module: 'first.js' }] }))
vi.mock('./useDshSlotEntries', () => ({ useDshSlotEntries: () => source.entries }))
vi.mock('./DshSlotSurface', () => ({ DshSlotSurface: () => null }))
vi.mock('./dshUiModules', () => ({ getLoadedDshUiModule: vi.fn(), importDshUiModule: vi.fn() }))
beforeEach(() => {
  source.entries = [{ id: 'view', module: 'first.js' }]
  vi.mocked(getLoadedDshUiModule).mockReset().mockReturnValue(null)
  vi.mocked(importDshUiModule).mockReset()
})

test('displays an already loaded module without waiting for the import read', () => {
  vi.mocked(getLoadedDshUiModule).mockReturnValue({ default: () => <span>Cached view</span> })
  vi.mocked(importDshUiModule).mockReturnValue(new Promise(() => {}))
  render(<DshContributionSlotSurface slot={WEWORK_DSH_SLOTS.home} />)
  expect(screen.getByText('Cached view')).toBeInTheDocument()
})

test('a late module import cannot replace a newer contribution', async () => {
  let finishOld!: (module: unknown) => void
  vi.mocked(importDshUiModule)
    .mockReturnValueOnce(
      new Promise(resolve => {
        finishOld = resolve
      })
    )
    .mockResolvedValueOnce({ default: () => <span>Current view</span> })
  const view = render(<DshContributionSlotSurface slot={WEWORK_DSH_SLOTS.home} />)
  source.entries = [{ id: 'view', module: 'second.js' }]
  view.rerender(<DshContributionSlotSurface slot={WEWORK_DSH_SLOTS.home} />)
  await screen.findByText('Current view')
  await act(async () => {
    finishOld({ default: () => <span>Old view</span> })
  })
  expect(screen.queryByText('Old view')).not.toBeInTheDocument()
  expect(screen.getByText('Current view')).toBeInTheDocument()
})
