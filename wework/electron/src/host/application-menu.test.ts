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

function createMenu(platform: NodeJS.Platform = 'darwin') {
  let built: Menu | null = null
  const dispatch = vi.fn()
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
        webContents: { id: 1 },
      }) as unknown as BrowserWindow,
    dispatch,
    openDevTools: vi.fn(),
    openLogDirectory: vi.fn(async () => undefined),
    showMain: vi.fn(async () => undefined),
    quit: vi.fn(),
    openExternal: vi.fn(async () => undefined),
    reportError: vi.fn(),
  })
  menu.setLanguage('en')
  return { menu, built: () => built!, dispatch }
}

describe('application menu model', () => {
  test('exposes every primary workbench surface with a stable id', () => {
    const { built } = createMenu()
    const ids = built().items.map(item => item.id)
    expect(ids).toEqual(['application', 'file', 'work', 'edit', 'view', 'window', 'help'])
    const item = (id: string) => built().getMenuItemById(id)!.label
    expect(item('work.tasks')).toBe('Tasks')
    expect(item('work.projectSpaces')).toBe('Project spaces')
    expect(item('file.newTaskTab')).toBe('New task tab')
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
      'application.settings',
      'file.newTaskTab',
      'work.tasks',
      'developer.devTools',
    ]) {
      expect(built().getMenuItemById(id)!.visible).toBe(true)
    }
  })

  test('dispatches the declared action for each menu item', () => {
    const { menu, dispatch } = createMenu()
    menu.setCapabilities({ [APPLICATION_MENU_CAPABILITIES.taskSurface]: true })
    for (const [id, action] of [
      ['work.tasks', APPLICATION_MENU_ACTIONS.openTasks],
      ['work.projectSpaces', APPLICATION_MENU_ACTIONS.openProjectSpaces],
      ['work.plugins', APPLICATION_MENU_ACTIONS.openPlugins],
      ['file.newTaskTab', APPLICATION_MENU_ACTIONS.newTaskTab],
      ['view.search', APPLICATION_MENU_ACTIONS.openSearch],
      ['view.terminal', APPLICATION_MENU_ACTIONS.openTerminal],
    ] as const) {
      dispatch.mockClear()
      expect(menu.activateForTesting(id, 'main')).toBe(true)
      expect(dispatch).toHaveBeenCalledWith(action, expect.anything())
    }
  })

  test('refuses to activate a hidden menu item', () => {
    const { menu, dispatch } = createMenu()
    menu.setCapabilities({})
    expect(menu.activateForTesting('view.terminal', 'main')).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
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
})
