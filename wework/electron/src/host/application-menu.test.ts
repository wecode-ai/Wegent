import { describe, expect, test, vi } from 'vitest'
import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron'
import {
  APPLICATION_MENU_ACTIONS,
  APPLICATION_MENU_CAPABILITIES,
  ApplicationMenu,
} from './application-menu'

function buildFakeMenu(template: MenuItemConstructorOptions[]): Menu {
  const items = template.map(entry => ({
    id: entry.id ?? '',
    label: typeof entry.label === 'string' ? entry.label : '',
    enabled: entry.enabled ?? true,
    visible: entry.visible ?? true,
    role: entry.role,
    accelerator: entry.accelerator,
    submenu: entry.submenu
      ? { items: buildFakeMenu(entry.submenu as MenuItemConstructorOptions[]).items }
      : undefined,
    click: entry.click,
  }))
  return {
    items,
    getMenuItemById: (id: string) => {
      const stack = [...items]
      while (stack.length) {
        const item = stack.shift()!
        if (item.id === id) return item as never
        if (item.submenu) stack.unshift(...item.submenu.items)
      }
      return null
    },
    popup: vi.fn(),
  } as unknown as Menu
}

function createMenu(
  platform: NodeJS.Platform = 'darwin',
  closeWindow?: () => BrowserWindow | null
) {
  let built: Menu | null = null
  const dispatch = vi.fn()
  const reload = vi.fn()
  const openExternal = vi.fn(async () => undefined)
  const openProcessExplorer = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const menu = new ApplicationMenu({
    platform,
    appName: 'Wework',
    buildMenu: template => {
      built = buildFakeMenu(template)
      return built
    },
    setApplicationMenu: () => undefined,
    targetWindow: () =>
      ({
        isDestroyed: () => false,
        webContents: { id: 1, reload },
      }) as unknown as BrowserWindow,
    closeWindow,
    dispatch,
    openDevTools: vi.fn(),
    openLogDirectory: vi.fn(async () => undefined),
    openProcessExplorer,
    showMain: vi.fn(async () => undefined),
    quit: vi.fn(),
    openExternal,
    reportError: vi.fn(),
  })
  menu.setLanguage('en')
  return {
    menu,
    built: () => built!,
    dispatch,
    reload,
    openExternal,
    openProcessExplorer,
  }
}

describe('application menu model', () => {
  test('opens the native Process Explorer without a renderer dispatch round trip', async () => {
    const { menu, dispatch, openProcessExplorer } = createMenu('linux')
    expect(await menu.activateForTesting('developer.processExplorer', 'main')).toBe(true)
    expect(openProcessExplorer).toHaveBeenCalledOnce()
    expect(dispatch).not.toHaveBeenCalled()
  })

  test('does not acknowledge the native Process Explorer before it is ready', async () => {
    const { menu, openProcessExplorer } = createMenu('linux')
    let ready!: () => void
    openProcessExplorer.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          ready = resolve
        })
    )
    let acknowledged = false
    const activation = Promise.resolve(
      menu.activateForTesting('developer.processExplorer', 'main')
    ).then(result => {
      acknowledged = true
      return result
    })
    await Promise.resolve()
    expect(acknowledged).toBe(false)
    ready()
    await expect(activation).resolves.toBe(true)
  })

  test.each(['darwin', 'win32', 'linux'] as const)(
    'refreshes the selected window from the View menu on %s',
    async platform => {
      const { menu, built, reload, dispatch } = createMenu(platform)
      menu.setCapabilities({})
      const item = built().getMenuItemById('view.refresh')!
      expect(item.label).toBe('Refresh')
      expect(item.visible).toBe(true)
      expect(item.accelerator).toBe('CommandOrControl+R')
      expect(await menu.activateForTesting('view.refresh', 'main')).toBe(true)
      expect(reload).toHaveBeenCalledOnce()
      expect(dispatch).not.toHaveBeenCalled()
      menu.setLanguage('zh-CN')
      expect(built().getMenuItemById('view.refresh')!.label).toBe('刷新')
    }
  )

  test('exposes every primary workbench surface with a stable id', () => {
    const { built } = createMenu()
    const ids = built().items.map(item => item.id)
    expect(ids).toEqual(['application', 'file', 'work', 'edit', 'view', 'window', 'help'])
    const item = (id: string) => built().getMenuItemById(id)!.label
    expect(item('work.tasks')).toBe('Tasks')
    expect(item('work.projectSpaces')).toBe('Project spaces')
    expect(item('file.newTaskTab')).toBe('New task tab')
    expect(item('developer.processExplorer')).toBe('Process Explorer')
  })

  test('hides capability-gated items until the capability is reported', () => {
    const { menu, built } = createMenu()
    for (const id of [
      'file.closeTab',
      'view.search',
      'view.sidebar',
      'view.sidePanel',
      'view.terminal',
    ]) {
      expect(built().getMenuItemById(id)!.visible).toBe(false)
    }
    menu.setCapabilities({
      [APPLICATION_MENU_CAPABILITIES.taskSurface]: true,
      [APPLICATION_MENU_CAPABILITIES.canCloseTab]: true,
    })
    for (const id of [
      'file.closeTab',
      'view.search',
      'view.sidebar',
      'view.sidePanel',
      'view.terminal',
    ]) {
      expect(built().getMenuItemById(id)!.visible).toBe(true)
    }
  })

  test('keeps capability-independent items visible regardless of state', () => {
    const { menu, built } = createMenu()
    menu.setCapabilities({})
    for (const id of [
      'application.about',
      'application.settings',
      'file.newTaskTab',
      'work.tasks',
      'developer.devTools',
    ]) {
      expect(built().getMenuItemById(id)!.visible).toBe(true)
    }
  })

  test('routes About through the in-app menu action instead of the native panel', () => {
    const { built } = createMenu()
    const about = built().getMenuItemById('application.about')!
    expect(about.label).toBe('About Wework')
    expect(about.role).toBeUndefined()
  })

  test('dispatches the declared action for each menu item', async () => {
    const { menu, dispatch } = createMenu()
    menu.setCapabilities({ [APPLICATION_MENU_CAPABILITIES.taskSurface]: true })
    for (const [id, action] of [
      ['application.about', APPLICATION_MENU_ACTIONS.openAbout],
      ['work.tasks', APPLICATION_MENU_ACTIONS.openTasks],
      ['work.projectSpaces', APPLICATION_MENU_ACTIONS.openProjectSpaces],
      ['work.plugins', APPLICATION_MENU_ACTIONS.openPlugins],
      ['file.newTaskTab', APPLICATION_MENU_ACTIONS.newTaskTab],
      ['view.search', APPLICATION_MENU_ACTIONS.openSearch],
      ['view.terminal', APPLICATION_MENU_ACTIONS.openTerminal],
      ['help.issues', APPLICATION_MENU_ACTIONS.openFeedback],
    ] as const) {
      dispatch.mockClear()
      expect(await menu.activateForTesting(id, 'main')).toBe(true)
      expect(dispatch).toHaveBeenCalledWith(action, expect.anything())
    }
  })

  test('keeps report issue inside the app instead of opening GitHub', async () => {
    const { menu, openExternal } = createMenu()
    expect(await menu.activateForTesting('help.issues', 'main')).toBe(true)
    expect(openExternal).not.toHaveBeenCalled()
  })

  test('refuses to activate a hidden menu item', async () => {
    const { menu, dispatch } = createMenu()
    menu.setCapabilities({})
    expect(await menu.activateForTesting('view.terminal', 'main')).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })

  test('closes the focused window from the window menu', () => {
    const close = vi.fn()
    const target = { isDestroyed: () => false, close } as unknown as BrowserWindow
    const { built } = createMenu('darwin', () => target)
    const item = built().getMenuItemById('window.close')!
    item.click!(item, target, {} as never)
    expect(close).toHaveBeenCalledOnce()
  })

  test('localizes the menu without changing item ids', () => {
    const { menu, built } = createMenu()
    const englishIds = built().items.map(item => item.id)
    menu.setLanguage('zh-CN')
    expect(built().items.map(item => item.id)).toEqual(englishIds)
    expect(built().getMenuItemById('work.tasks')!.label).toBe('任务')
  })

  test('uses the system window menu role on macOS only', () => {
    expect(createMenu('darwin').built().getMenuItemById('window')!.role).toBe('windowMenu')
    expect(createMenu('win32').built().getMenuItemById('window')!.role).toBeUndefined()
  })

  test('keeps the framework quit shortcut on each platform', () => {
    expect(createMenu('darwin').built().getMenuItemById('application.quit')!.accelerator).toBe(
      'Command+Q'
    )
    expect(createMenu('linux').built().getMenuItemById('application.quit')!.accelerator).toBe(
      'Control+Q'
    )
    expect(
      createMenu('win32').built().getMenuItemById('application.quit')!.accelerator
    ).toBeUndefined()
  })
})
