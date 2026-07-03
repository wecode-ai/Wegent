import { beforeEach, describe, expect, test, vi } from 'vitest'

const listenMock = vi.hoisted(() => vi.fn())
const invokeMock = vi.hoisted(() => vi.fn())
const navigateToMock = vi.hoisted(() => vi.fn())
const buildRuntimeTaskRouteMock = vi.hoisted(() => vi.fn())
const isTauriRuntimeMock = vi.hoisted(() => vi.fn())
const i18nMock = vi.hoisted(() => ({
  language: 'zh-CN',
  resolvedLanguage: 'zh-CN' as string | undefined,
  on: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

vi.mock('@/lib/navigation', () => ({
  buildRuntimeTaskRoute: buildRuntimeTaskRouteMock,
  navigateTo: navigateToMock,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: isTauriRuntimeMock,
}))

vi.mock('@/i18n', () => ({
  default: i18nMock,
}))

describe('trayNavigation', () => {
  beforeEach(() => {
    vi.resetModules()
    listenMock.mockReset()
    invokeMock.mockReset()
    navigateToMock.mockReset()
    buildRuntimeTaskRouteMock.mockReset()
    isTauriRuntimeMock.mockReset()
    i18nMock.on.mockReset()
    i18nMock.language = 'zh-CN'
    i18nMock.resolvedLanguage = 'zh-CN'
    listenMock.mockResolvedValue(vi.fn())
    invokeMock.mockResolvedValue(undefined)
    buildRuntimeTaskRouteMock.mockImplementation(
      ({ deviceId, taskId }: { deviceId: string; taskId: number }) =>
        `/runtime-tasks?deviceId=${encodeURIComponent(deviceId)}&taskId=${encodeURIComponent(
          String(taskId)
        )}`
    )
  })

  test('does not subscribe outside the Tauri runtime', async () => {
    isTauriRuntimeMock.mockReturnValue(false)

    const { installTraySettingsNavigation } = await import('./trayNavigation')
    installTraySettingsNavigation()

    expect(listenMock).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('opens settings when the tray settings event is received', async () => {
    const handlers = new Map<string, () => void>()
    isTauriRuntimeMock.mockReturnValue(true)
    listenMock.mockImplementation((_eventName: string, callback: unknown) => {
      handlers.set(_eventName, callback as () => void)
      return Promise.resolve(vi.fn())
    })

    const { installTraySettingsNavigation, WEWORK_TRAY_OPEN_SETTINGS_EVENT } =
      await import('./trayNavigation')

    installTraySettingsNavigation()
    installTraySettingsNavigation()

    expect(listenMock).toHaveBeenCalledTimes(2)
    expect(listenMock).toHaveBeenCalledWith(WEWORK_TRAY_OPEN_SETTINGS_EVENT, expect.any(Function))

    handlers.get(WEWORK_TRAY_OPEN_SETTINGS_EVENT)?.()

    expect(navigateToMock).toHaveBeenCalledWith('/settings')
  })

  test('opens a runtime task when the tray task event is received', async () => {
    const handlers = new Map<string, (event: { payload: { id: string } }) => void>()
    isTauriRuntimeMock.mockReturnValue(true)
    listenMock.mockImplementation((_eventName: string, callback: unknown) => {
      handlers.set(_eventName, callback as (event: { payload: { id: string } }) => void)
      return Promise.resolve(vi.fn())
    })

    const { installTraySettingsNavigation, WEWORK_TRAY_OPEN_TASK_EVENT } =
      await import('./trayNavigation')
    const { createTrayTaskMenuId } = await import('./trayTaskMenuId')

    installTraySettingsNavigation()

    handlers.get(WEWORK_TRAY_OPEN_TASK_EVENT)?.({
      payload: {
        id: createTrayTaskMenuId({
          deviceId: 'device/1',
          taskId: '101',
        }),
      },
    })

    expect(buildRuntimeTaskRouteMock).toHaveBeenCalledWith({
      deviceId: 'device/1',
      taskId: '101',
    })
    expect(navigateToMock).toHaveBeenCalledWith(
      '/runtime-tasks?deviceId=device%2F1&taskId=101'
    )
  })

  test('syncs the tray menu state on install and language changes', async () => {
    let languageChangedHandler: ((language: string) => void) | undefined
    isTauriRuntimeMock.mockReturnValue(true)
    i18nMock.resolvedLanguage = 'en-US'
    i18nMock.on.mockImplementation((eventName: string, callback: unknown) => {
      if (eventName === 'languageChanged') {
        languageChangedHandler = callback as (language: string) => void
      }
      return i18nMock
    })

    const { installTraySettingsNavigation, SET_TRAY_MENU_STATE_COMMAND, syncTrayMenuState } =
      await import('./trayNavigation')

    installTraySettingsNavigation()
    installTraySettingsNavigation()

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith(SET_TRAY_MENU_STATE_COMMAND, {
      state: {
        language: 'en',
        running: [],
        runningMore: [],
        pinned: [],
        pinnedMore: [],
        recent: [],
        recentMore: [],
      },
    })
    expect(i18nMock.on).toHaveBeenCalledTimes(1)

    const taskGroups = {
      running: [{ id: 'task-1', title: 'Running task', projectName: 'Wegent' }],
      runningMore: [],
      pinned: [],
      pinnedMore: [],
      recent: [{ id: 'task-1', title: 'Running task', projectName: 'Wegent' }],
      recentMore: [],
    }
    syncTrayMenuState(taskGroups, 'en-US')

    expect(invokeMock).toHaveBeenLastCalledWith(SET_TRAY_MENU_STATE_COMMAND, {
      state: {
        language: 'en',
        ...taskGroups,
      },
    })

    languageChangedHandler?.('zh-CN')

    expect(invokeMock).toHaveBeenLastCalledWith(SET_TRAY_MENU_STATE_COMMAND, {
      state: {
        language: 'zh-CN',
        ...taskGroups,
      },
    })
  })
})
