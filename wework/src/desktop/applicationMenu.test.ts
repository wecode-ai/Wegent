import { beforeEach, describe, expect, test, vi } from 'vitest'
import { installApplicationMenuNavigation } from './applicationMenu'

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  invoke: vi.fn(async () => undefined),
  navigate: vi.fn(),
  openDeveloperCommandMenu: vi.fn(),
  requestOpenTaskSearch: vi.fn(),
  dispatchBuiltinShortcutCommand: vi.fn(),
  i18nOn: vi.fn(),
  resolvedLanguage: 'zh-CN',
}))
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.invoke,
  subscribeDesktopHostEvents: mocks.subscribe,
}))
vi.mock('@/i18n', () => ({
  default: {
    get resolvedLanguage() {
      return mocks.resolvedLanguage
    },
    language: 'zh-CN',
    on: mocks.i18nOn,
  },
}))
vi.mock('@/lib/runtime-environment', () => ({ getDesktopWindowLabel: () => 'main' }))
vi.mock('@/lib/navigation', () => ({ navigateTo: mocks.navigate }))
vi.mock('@/lib/developerCommandMenu', () => ({
  openDeveloperCommandMenu: mocks.openDeveloperCommandMenu,
}))
vi.mock('@/components/layout/workbenchShellEvents', () => ({
  requestOpenTaskSearch: mocks.requestOpenTaskSearch,
}))
vi.mock('@/lib/keybindings', () => ({
  OPEN_TERMINAL_COMMAND: 'openTerminal',
  TOGGLE_SIDEBAR_COMMAND: 'toggleSidebar',
  TOGGLE_SIDE_PANEL_COMMAND: 'toggleSidePanel',
  INCREASE_FONT_SIZE_COMMAND: 'increaseFontSize',
  DECREASE_FONT_SIZE_COMMAND: 'decreaseFontSize',
  RESET_FONT_SIZE_COMMAND: 'resetFontSize',
  dispatchBuiltinShortcutCommand: mocks.dispatchBuiltinShortcutCommand,
}))

function emit(action: string, windowLabel = 'main') {
  installApplicationMenuNavigation()
  const handler = mocks.subscribe.mock.calls.at(-1)![0] as (event: unknown) => void
  handler({ type: 'application-menu.action', sequence: 1, payload: { action, windowLabel } })
}

describe('application menu navigation actions', () => {
  beforeEach(() => vi.clearAllMocks())

  test('opens settings through the workbench router', () => {
    emit('open-settings')
    expect(mocks.navigate).toHaveBeenCalledWith('/settings')
  })

  test('opens the developer command menu', () => {
    emit('developer-commands')
    expect(mocks.openDeveloperCommandMenu).toHaveBeenCalledOnce()
  })

  test('opens task search through the workbench shell event', () => {
    emit('open-search')
    expect(mocks.requestOpenTaskSearch).toHaveBeenCalledOnce()
  })

  test('routes terminal, panel, and font actions through builtin commands', () => {
    for (const [action, command] of [
      ['open-terminal', 'openTerminal'],
      ['toggle-sidebar', 'toggleSidebar'],
      ['toggle-side-panel', 'toggleSidePanel'],
      ['increaseFontSize', 'increaseFontSize'],
      ['decreaseFontSize', 'decreaseFontSize'],
      ['resetFontSize', 'resetFontSize'],
    ] as const) {
      mocks.dispatchBuiltinShortcutCommand.mockClear()
      emit(action)
      expect(mocks.dispatchBuiltinShortcutCommand).toHaveBeenCalledWith(command)
    }
  })

  test('ignores actions addressed to another window', () => {
    emit('open-settings', 'workspace-one')
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})

describe('application menu language sync', () => {
  beforeEach(() => vi.clearAllMocks())

  async function installFreshLanguageSync() {
    // The installer is idempotent per process, so each case reloads the module
    // to observe its own registration.
    vi.resetModules()
    const module = await import('./applicationMenu')
    module.installApplicationMenuLanguageSync()
  }

  test('reports the resolved in-app language instead of the OS locale', async () => {
    mocks.resolvedLanguage = 'zh-CN'
    await installFreshLanguageSync()
    expect(mocks.invoke).toHaveBeenCalledWith('applicationMenu.setLanguage', {
      language: 'zh-CN',
    })
  })

  test('follows later in-app language changes', async () => {
    await installFreshLanguageSync()
    const handler = mocks.i18nOn.mock.calls.find(call => call[0] === 'languageChanged')?.[1] as (
      language: string
    ) => void
    expect(handler).toBeTypeOf('function')
    handler('en')
    expect(mocks.invoke).toHaveBeenCalledWith('applicationMenu.setLanguage', { language: 'en' })
  })
})
