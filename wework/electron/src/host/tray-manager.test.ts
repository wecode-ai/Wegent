import { describe, expect, test, vi } from 'vitest'
import {
  ElectronTrayManager,
  type TrayAction,
  type TrayAdapter,
  type TrayManagerDependencies,
  type TrayMenuState,
  type TrayMenuTemplateItem,
} from './tray-manager.js'

function state(overrides: Partial<TrayMenuState> = {}): TrayMenuState {
  return {
    language: 'en',
    usageTitle: '42%',
    usageTooltip: 'Codex: 42%',
    running: [],
    runningMore: [],
    unread: [],
    unreadMore: [],
    pinned: [],
    pinnedMore: [],
    recent: [],
    recentMore: [],
    hasRunningTasks: false,
    showRunningStatus: false,
    runningCount: 0,
    activeTaskIds: null,
    unreadCount: 0,
    ...overrides,
  }
}

function setup(
  platform: NodeJS.Platform = 'darwin',
  applyIcon?: TrayManagerDependencies['applyIcon']
) {
  const guid = 'b3dce801-ead2-5b83-bc0a-7be0b543c833'
  const listeners = new Map<'click' | 'double-click', () => void>()
  const tray: TrayAdapter = {
    on: vi.fn((event, listener) => {
      listeners.set(event, listener)
    }),
    setContextMenu: vi.fn(),
    setToolTip: vi.fn(),
    setTitle: vi.fn(),
    getGUID: vi.fn(() => guid),
    destroy: vi.fn(),
  }
  const dispatchAction = vi.fn<(action: TrayAction) => void>()
  const buildMenu = vi.fn((template: TrayMenuTemplateItem[]) => ({ template }))
  const dependencies: TrayManagerDependencies = {
    createTray: vi.fn(() => tray),
    buildMenu,
    dispatchAction,
    applyIcon,
    platform,
  }
  const manager = new ElectronTrayManager(dependencies)

  return { buildMenu, dependencies, dispatchAction, guid, listeners, manager, tray }
}

function findItem(template: TrayMenuTemplateItem[], id: string): TrayMenuTemplateItem | undefined {
  for (const item of template) {
    if (item.id === id) {
      return item
    }
    const nested = item.submenu ? findItem(item.submenu, id) : undefined
    if (nested) {
      return nested
    }
  }
  return undefined
}

describe('ElectronTrayManager', () => {
  test('creates and destroys one tray while applying the latest state', () => {
    const { buildMenu, dependencies, guid, manager, tray } = setup()
    manager.setState(state())

    manager.create()
    manager.create()

    expect(dependencies.createTray).toHaveBeenCalledTimes(1)
    expect(buildMenu).toHaveBeenCalledTimes(1)
    expect(tray.setContextMenu).toHaveBeenCalledWith({
      template: buildMenu.mock.calls[0][0],
    })
    expect(tray.setToolTip).toHaveBeenCalledWith('Codex: 42%')
    expect(tray.setTitle).toHaveBeenCalledWith('42%')
    expect(manager.snapshot()).toMatchObject({ created: true, guid })

    manager.destroy()
    manager.destroy()

    expect(tray.destroy).toHaveBeenCalledTimes(1)
    expect(manager.snapshot()).toMatchObject({ created: false, guid: null })
  })

  test('builds localized running, unread, pinned, recent, and action menus', () => {
    const { buildMenu, manager } = setup()
    manager.setState(
      state({
        running: [{ id: 'running-1', title: 'Build', projectName: 'Wegent' }],
        runningMore: [{ id: 'running-2', title: '', projectName: 'Ignored' }],
        unread: [{ id: 'unread-1', title: 'Review', projectName: '' }],
        pinned: [{ id: 'pinned-1', title: 'Pinned task', projectName: 'Core' }],
        recent: [{ id: 'recent-1', title: 'Recent task', projectName: 'Desktop' }],
        recentMore: [{ id: 'recent-2', title: 'Older task', projectName: 'Desktop' }],
      })
    )
    manager.create()

    const template = buildMenu.mock.calls[0][0]
    expect(template.map(item => item.label ?? item.type)).toEqual([
      'Unread Completed',
      'Review',
      'separator',
      'Running',
      'Build - Wegent',
      'More',
      'separator',
      'Pinned',
      'Pinned task - Core',
      'separator',
      'Tasks',
      'Recent task - Desktop',
      'More',
      'separator',
      'Open App',
      'separator',
      'Settings',
      'separator',
      'Quit App',
    ])
    expect(findItem(template, 'task:running-2')?.label).toBe('Untitled Task')
    expect(findItem(template, 'more:recent')?.submenu?.[0]?.label).toBe('Older task - Desktop')
  })

  test('keeps pinned and recent empty states while omitting empty transient sections', () => {
    const { manager } = setup()
    manager.setState(state({ language: 'zh-CN' }))

    const snapshot = manager.snapshot()
    expect(snapshot.menu.map(item => item.label ?? item.type)).toEqual([
      '置顶',
      '暂无置顶任务',
      'separator',
      '任务',
      '暂无任务',
      'separator',
      '打开应用',
      'separator',
      '设置',
      'separator',
      '退出应用',
    ])
  })

  test('routes real icon events, menu clicks, and test activation through typed actions', () => {
    const { buildMenu, dispatchAction, listeners, manager } = setup()
    manager.setState(
      state({
        recent: [{ id: 'encoded-task-address', title: 'Task', projectName: 'Project' }],
      })
    )
    manager.create()
    const template = buildMenu.mock.calls[0][0]

    listeners.get('click')?.()
    listeners.get('double-click')?.()
    findItem(template, 'settings')?.click?.()
    findItem(template, 'task:encoded-task-address')?.click?.()
    expect(manager.activate({ type: 'menu-item', menuItemId: 'quit' })).toBe(true)
    expect(manager.activate({ type: 'menu-item', menuItemId: 'missing' })).toBe(false)

    expect(dispatchAction.mock.calls.map(([action]) => action)).toEqual([
      { type: 'open-app', source: 'tray-icon' },
      { type: 'open-app', source: 'tray-icon' },
      { type: 'open-settings', source: 'tray-menu' },
      {
        type: 'open-task',
        source: 'tray-menu',
        taskId: 'encoded-task-address',
      },
      { type: 'quit-app', source: 'tray-menu' },
    ])
  })

  test('uses the default tooltip and only sets a native title on macOS', () => {
    const mac = setup('darwin')
    mac.manager.setState(state({ usageTitle: null, usageTooltip: '  ' }))
    mac.manager.create()

    expect(mac.tray.setToolTip).toHaveBeenCalledWith('WeWork')
    expect(mac.tray.setTitle).toHaveBeenCalledWith('')
    expect(mac.manager.snapshot()).toMatchObject({
      title: null,
      titleSupported: true,
      tooltip: 'WeWork',
    })

    const windows = setup('win32')
    windows.manager.setState(state())
    windows.manager.create()

    expect(windows.tray.setTitle).not.toHaveBeenCalled()
    expect(windows.manager.snapshot()).toMatchObject({
      title: '42%',
      titleSupported: false,
      tooltip: 'Codex: 42%',
    })
  })

  test('uses the platform icon renderer when one is provided', () => {
    const applyIcon = vi.fn()
    const { manager, tray } = setup('darwin', applyIcon)

    manager.setState(state({ usageTitle: 'Codex  79%\nAIGC 845.21' }))
    manager.create()

    expect(applyIcon).toHaveBeenCalledWith(
      tray,
      expect.objectContaining({ usageTitle: 'Codex  79%\nAIGC 845.21' })
    )
    expect(tray.setTitle).not.toHaveBeenCalled()
  })

  test('keeps renderer menu items while native status owns usage and running count', () => {
    const applyIcon = vi.fn()
    const { manager, tray } = setup('darwin', applyIcon)
    manager.setState(
      state({
        usageTitle: 'renderer',
        usageTooltip: null,
        running: [{ id: 'task-1', title: 'Task', projectName: 'Project' }],
      })
    )
    manager.setNativeStatus({
      usageTitle: '5h 80%\n7d 60%',
      usageTooltip: '1 个任务运行中',
      runningCount: 1,
      showRunningStatus: true,
    })
    manager.create()

    expect(manager.snapshot()).toMatchObject({
      title: '5h 80%\n7d 60%',
      tooltip: '1 个任务运行中',
    })
    expect(applyIcon).toHaveBeenCalledWith(
      tray,
      expect.objectContaining({
        runningCount: 1,
        showRunningStatus: true,
        usageTitle: '5h 80%\n7d 60%',
      })
    )
    expect(manager.snapshot().menu).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'task:task-1' })])
    )
  })

  test('updates the native menu and visual state after creation', () => {
    const { buildMenu, manager, tray } = setup()
    manager.create()
    manager.setState(state({ usageTitle: '7%', usageTooltip: 'Usage: 7%' }))

    expect(buildMenu).toHaveBeenCalledTimes(2)
    expect(tray.setContextMenu).toHaveBeenCalledTimes(2)
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Usage: 7%')
    expect(tray.setTitle).toHaveBeenLastCalledWith('7%')
  })

  test('returns a serializable snapshot without native menus or click functions', () => {
    const { manager } = setup()
    manager.setState(
      state({
        running: [{ id: 'task-1', title: 'Run', projectName: 'Project' }],
        runningMore: [{ id: 'task-2', title: 'More', projectName: 'Project' }],
      })
    )

    const snapshot = manager.snapshot()
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
    expect(snapshot.menu).toContainEqual({
      id: 'heading:running',
      label: 'Running',
      enabled: false,
      type: 'normal',
    })
    expect(snapshot.menu.find(item => item.id === 'more:running')?.submenu).toContainEqual({
      id: 'task:task-2',
      label: 'More - Project',
      type: 'normal',
    })
  })
})
