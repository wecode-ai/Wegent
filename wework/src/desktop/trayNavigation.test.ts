import { beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { installTraySettingsNavigation, syncTrayMenuState } from './trayNavigation'

vi.mock('@/i18n', () => ({
  default: {
    language: 'zh-CN',
    resolvedLanguage: 'zh-CN',
    on: vi.fn(),
  },
}))

describe('trayNavigation', () => {
  beforeEach(() => {
    vi.mocked(i18n.on).mockClear()
  })

  test('installs desktop tray language synchronization once', () => {
    installTraySettingsNavigation()
    installTraySettingsNavigation()

    expect(i18n.on).toHaveBeenCalledTimes(1)
    expect(i18n.on).toHaveBeenCalledWith('languageChanged', expect.any(Function))
  })

  test('accepts Electron tray state updates without a legacy native command', () => {
    expect(() =>
      syncTrayMenuState(
        {
          unread: [],
          running: [],
          usage: [],
        },
        'en',
        { title: 'Usage', tooltip: 'Usage details' }
      )
    ).not.toThrow()
  })
})
