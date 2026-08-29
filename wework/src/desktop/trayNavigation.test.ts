import { beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { installTraySettingsNavigation, syncTrayMenuState } from './trayNavigation'

const desktopHostMocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn().mockReturnValue(() => {}),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopHostMocks.invoke,
  subscribeDesktopHostEvents: desktopHostMocks.subscribe,
}))

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
    desktopHostMocks.invoke.mockClear()
    desktopHostMocks.subscribe.mockClear()
  })

  test('installs desktop tray language synchronization once', () => {
    installTraySettingsNavigation()
    installTraySettingsNavigation()

    expect(i18n.on).toHaveBeenCalledTimes(1)
    expect(i18n.on).toHaveBeenCalledWith('languageChanged', expect.any(Function))
    expect(desktopHostMocks.subscribe).toHaveBeenCalledTimes(1)
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
