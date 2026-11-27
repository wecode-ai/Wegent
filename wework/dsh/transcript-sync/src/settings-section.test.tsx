import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { clearDshUiModuleCache } from '@/features/dsh-runtime/dshUiModules'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import TranscriptSyncSettingsSection from './settings-section'

afterEach(() => {
  clearDshUiModuleCache()
  vi.unstubAllGlobals()
})

it('renders transcript sync controls in the host settings contribution', async () => {
  const setEnabled = vi.fn()
  const snapshot = {
    enabled: false,
    error: null,
    pending: false,
    status: null,
    statusPending: false,
    statusRefreshing: false,
  }
  const entry = {
    id: 'wework-transcript-sync',
    module: 'plugins/wework-ui-transcript-sync-settings.js',
    store: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      setEnabled,
    },
  }
  const attach = vi.fn()
  vi.stubGlobal('__WEWORK_DSH_UI__', {
    attach,
    getEntries: () => [entry],
    subscribe: () => () => {},
  })
  vi.stubGlobal('__WEWORK_DSH_UI_MODULES__', {
    [entry.module]: { default: TranscriptSyncSettingsSection },
  })
  vi.stubGlobal('__WEWORK_DSH_EXTENSIONS__', {
    contributions: { get: () => entry },
    localization: { translate: (messages: Record<string, string>) => messages['zh-CN'] },
  })

  render(<DshContributionSlotSurface slot={WEWORK_DSH_SLOTS.settingsSection} />)

  const checkbox = await screen.findByRole('checkbox', { name: '跨设备同步会话和配置' })
  expect(checkbox).not.toBeChecked()
  expect(screen.getByTestId('transcript-sync-enabled-status')).toHaveTextContent('同步已关闭')
  fireEvent.click(checkbox)
  expect(setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  expect(attach).not.toHaveBeenCalled()
})
