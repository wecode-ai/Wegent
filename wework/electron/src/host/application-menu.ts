import type { BrowserWindow, Menu, MenuItem, MenuItemConstructorOptions } from 'electron'

/**
 * Native application menu for the Wework desktop workbench.
 *
 * Items are declared in a single table so ids, actions, and visibility
 * conditions stay together. See wework/AGENTS.md for the rules when adding a
 * menu item.
 */

export const APPLICATION_MENU_ACTIONS = {
  openSettings: 'open-settings',
  openTasks: 'open-tasks',
  openProjectSpaces: 'open-project-spaces',
  openPlugins: 'open-plugins',
  openAutomations: 'open-automations',
  openApplications: 'open-applications',
  newTaskTab: 'new-task-tab',
  newProjectSpaceTab: 'new-project-space-tab',
  closeTab: 'close-tab',
  openSearch: 'open-search',
  toggleSidebar: 'toggle-sidebar',
  toggleSidePanel: 'toggle-side-panel',
  openTerminal: 'open-terminal',
  increaseFontSize: 'increaseFontSize',
  decreaseFontSize: 'decreaseFontSize',
  resetFontSize: 'resetFontSize',
  developerCommands: 'developer-commands',
} as const

export type ApplicationMenuAction =
  (typeof APPLICATION_MENU_ACTIONS)[keyof typeof APPLICATION_MENU_ACTIONS]

export const APPLICATION_MENU_CAPABILITIES = {
  canCloseTab: 'canCloseTab',
  taskSurface: 'taskSurface',
} as const

export type ApplicationMenuCapability =
  (typeof APPLICATION_MENU_CAPABILITIES)[keyof typeof APPLICATION_MENU_CAPABILITIES]

export type ApplicationMenuCapabilityState = Partial<Record<ApplicationMenuCapability, boolean>>

export const EMPTY_APPLICATION_MENU_CAPABILITIES: ApplicationMenuCapabilityState = {}

/** Maps the local font-size menu ids to their dispatched actions. */
const FONT_SIZE_ACTIONS = {
  increaseFontSize: APPLICATION_MENU_ACTIONS.increaseFontSize,
  decreaseFontSize: APPLICATION_MENU_ACTIONS.decreaseFontSize,
  resetFontSize: APPLICATION_MENU_ACTIONS.resetFontSize,
} as const

export interface ApplicationMenuSnapshotItem {
  id: string
  label: string
  enabled: boolean
  visible: boolean
  role: string | undefined
  accelerator: string | undefined
  submenu: ApplicationMenuSnapshotItem[]
}

function snapshotItem(item: MenuItem): ApplicationMenuSnapshotItem {
  return {
    id: item.id,
    label: item.label,
    enabled: item.enabled,
    visible: item.visible,
    role: item.role,
    accelerator: item.accelerator ?? undefined,
    submenu: item.submenu?.items.map(snapshotItem) ?? [],
  }
}

export interface ApplicationMenuDependencies {
  platform: NodeJS.Platform
  appName: string
  buildMenu: (template: MenuItemConstructorOptions[]) => Menu
  setApplicationMenu: (menu: Menu) => void
  targetWindow: (label?: string) => BrowserWindow | null
  dispatch: (action: ApplicationMenuAction, window: BrowserWindow) => void
  openDevTools: (window: BrowserWindow) => void
  openLogDirectory: () => Promise<void>
  showMain: () => Promise<void>
  quit: () => void
  openExternal: (url: string) => Promise<void>
  reportError: (error: unknown) => void
}

const EN_LABELS = {
  application: 'Application',
  about: 'About',
  settings: 'Settings…',
  quit: 'Quit',
  edit: 'Edit',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select all',
  view: 'View',
  fullscreen: 'Toggle full screen',
  increaseFontSize: 'Increase font size',
  decreaseFontSize: 'Decrease font size',
  resetFontSize: 'Reset font size',
  window: 'Window',
  minimize: 'Minimize',
  close: 'Close window',
  showMain: 'Show main window',
  help: 'Help',
  project: 'Project on GitHub',
  issues: 'Report an issue',
  developer: 'Developer tools',
  devTools: 'Open Chromium DevTools',
  commands: 'Developer commands…',
  logs: 'Open log directory',
  file: 'File',
  newTaskTab: 'New task tab',
  newProjectSpaceTab: 'New project space tab',
  newBlankProject: 'New blank code project…',
  importProject: 'Add code folder…',
  cloneProject: 'Clone repository…',
  closeTab: 'Close workspace tab',
  work: 'Work',
  tasks: 'Tasks',
  projectSpaces: 'Project spaces',
  plugins: 'Plugins',
  automations: 'Scheduled',
  applications: 'Applications',
  search: 'Search tasks',
  sidebar: 'Toggle sidebar',
  sidePanel: 'Toggle side panel',
  terminal: 'Toggle terminal panel',
}

const ZH_LABELS: typeof EN_LABELS = {
  application: '应用',
  about: '关于',
  settings: '设置…',
  quit: '退出',
  edit: '编辑',
  undo: '撤销',
  redo: '重做',
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  selectAll: '全选',
  view: '查看',
  fullscreen: '切换全屏',
  increaseFontSize: '增大字号',
  decreaseFontSize: '减小字号',
  resetFontSize: '重置字号',
  window: '窗口',
  minimize: '最小化',
  close: '关闭窗口',
  showMain: '显示主窗口',
  help: '帮助',
  project: 'GitHub 项目主页',
  issues: '报告问题',
  developer: '开发者工具',
  devTools: '打开 Chromium 开发者工具',
  commands: '开发者命令…',
  logs: '打开日志目录',
  file: '文件',
  newTaskTab: '新建任务标签页',
  newProjectSpaceTab: '新建项目空间标签页',
  newBlankProject: '新建空白代码项目…',
  importProject: '添加代码文件夹…',
  cloneProject: '克隆仓库…',
  closeTab: '关闭工作区标签页',
  work: '工作',
  tasks: '任务',
  projectSpaces: '项目空间',
  plugins: '插件',
  automations: '已安排',
  applications: '应用',
  search: '搜索任务',
  sidebar: '切换侧边栏',
  sidePanel: '切换侧边面板',
  terminal: '切换终端面板',
}

/**
 * Menu items whose id must be present and whose visibility is capability-driven.
 * The renderer reports the capability values; see applicationMenuModel.ts.
 */
const CAPABILITY_ITEM_IDS: ReadonlyArray<[string, ApplicationMenuCapability]> = [
  ['file.closeTab', APPLICATION_MENU_CAPABILITIES.canCloseTab],
  ['view.search', APPLICATION_MENU_CAPABILITIES.taskSurface],
  ['view.sidebar', APPLICATION_MENU_CAPABILITIES.taskSurface],
  ['view.sidePanel', APPLICATION_MENU_CAPABILITIES.taskSurface],
  ['view.terminal', APPLICATION_MENU_CAPABILITIES.taskSurface],
]

export class ApplicationMenu {
  private menu: Menu | null = null
  private language: string | null = null
  private popupWindow: BrowserWindow | null = null
  private capabilities: ApplicationMenuCapabilityState = EMPTY_APPLICATION_MENU_CAPABILITIES

  constructor(private readonly dependencies: ApplicationMenuDependencies) {}

  setLanguage(language: string): void {
    // Wework ships two languages. Every non-English tag is treated as Chinese;
    // add explicit branches before introducing a third language, otherwise it
    // would silently fall back to zh-CN.
    const normalized = language.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
    if (this.language === normalized) return
    this.language = normalized
    this.menu = this.dependencies.buildMenu(this.template(normalized))
    this.dependencies.setApplicationMenu(this.menu)
    this.applyCapabilities()
  }

  setCapabilities(capabilities: ApplicationMenuCapabilityState): void {
    this.capabilities = capabilities
    this.applyCapabilities()
  }

  private applyCapabilities(): void {
    if (!this.menu) return
    for (const [id, capability] of CAPABILITY_ITEM_IDS) {
      const item = this.menu.getMenuItemById(id)
      if (item) item.visible = this.capabilities[capability] === true
    }
  }

  popup(windowLabel: string): void {
    const window = this.dependencies.targetWindow(windowLabel)
    if (!this.menu || !window || window.isDestroyed()) {
      throw new Error('Application menu window is unavailable')
    }
    this.popupWindow = window
    this.menu.popup({
      window,
      callback: () => {
        this.popupWindow = null
      },
    })
  }

  snapshot(): ApplicationMenuSnapshotItem[] {
    return this.menu?.items.map(snapshotItem) ?? []
  }

  activateForTesting(id: string, windowLabel: string): boolean {
    const item = this.menu?.getMenuItemById(id)
    const window = this.dependencies.targetWindow(windowLabel)
    if (!item?.enabled || !item.visible || !window || window.isDestroyed() || item.submenu) {
      return false
    }
    this.popupWindow = window
    try {
      item.click(item, window, {} as Electron.KeyboardEvent)
      return true
    } finally {
      this.popupWindow = null
    }
  }

  private withWindow(action: (window: BrowserWindow) => void): void {
    const window = this.popupWindow ?? this.dependencies.targetWindow()
    if (window && !window.isDestroyed()) action(window)
  }

  private dispatch(action: ApplicationMenuAction): () => void {
    return () => this.withWindow(window => this.dependencies.dispatch(action, window))
  }

  private run(action: () => Promise<void>): () => void {
    return () => void action().catch(this.dependencies.reportError)
  }

  private template(language: string): MenuItemConstructorOptions[] {
    const labels = language === 'zh-CN' ? ZH_LABELS : EN_LABELS
    const mac = this.dependencies.platform === 'darwin'
    const separator: MenuItemConstructorOptions = { type: 'separator' }
    const application: MenuItemConstructorOptions[] = [
      { role: 'about', label: `${labels.about} ${this.dependencies.appName}` },
      separator,
      { id: 'application.settings', label: labels.settings, click: this.dispatch('open-settings') },
      ...(mac
        ? [
            separator,
            { role: 'services' as const },
            separator,
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
          ]
        : []),
      separator,
      {
        id: 'application.quit',
        label: labels.quit,
        accelerator: mac ? 'Command+Q' : undefined,
        click: this.dependencies.quit,
      },
    ]
    return [
      {
        id: 'application',
        label: mac ? this.dependencies.appName : labels.application,
        submenu: application,
      },
      {
        id: 'file',
        label: labels.file,
        submenu: [
          {
            id: 'file.newTaskTab',
            label: labels.newTaskTab,
            accelerator: 'CommandOrControl+N',
            click: this.dispatch('new-task-tab'),
          },
          {
            id: 'file.newProjectSpaceTab',
            label: labels.newProjectSpaceTab,
            click: this.dispatch('new-project-space-tab'),
          },
          separator,
          {
            id: 'file.closeTab',
            label: labels.closeTab,
            accelerator: 'CommandOrControl+W',
            visible: false,
            click: this.dispatch('close-tab'),
          },
        ],
      },
      {
        id: 'work',
        label: labels.work,
        submenu: [
          { id: 'work.tasks', label: labels.tasks, click: this.dispatch('open-tasks') },
          {
            id: 'work.projectSpaces',
            label: labels.projectSpaces,
            click: this.dispatch('open-project-spaces'),
          },
          separator,
          { id: 'work.plugins', label: labels.plugins, click: this.dispatch('open-plugins') },
          {
            id: 'work.automations',
            label: labels.automations,
            click: this.dispatch('open-automations'),
          },
          {
            id: 'work.applications',
            label: labels.applications,
            click: this.dispatch('open-applications'),
          },
        ],
      },
      {
        id: 'edit',
        label: labels.edit,
        submenu: [
          { role: 'undo', label: labels.undo },
          { role: 'redo', label: labels.redo },
          separator,
          { role: 'cut', label: labels.cut },
          { role: 'copy', label: labels.copy },
          { role: 'paste', label: labels.paste },
          { role: 'selectAll', label: labels.selectAll },
        ],
      },
      {
        id: 'view',
        label: labels.view,
        submenu: [
          {
            id: 'view.search',
            label: labels.search,
            visible: false,
            click: this.dispatch('open-search'),
          },
          separator,
          {
            id: 'view.sidebar',
            label: labels.sidebar,
            visible: false,
            click: this.dispatch('toggle-sidebar'),
          },
          {
            id: 'view.sidePanel',
            label: labels.sidePanel,
            visible: false,
            click: this.dispatch('toggle-side-panel'),
          },
          {
            id: 'view.terminal',
            label: labels.terminal,
            visible: false,
            click: this.dispatch('open-terminal'),
          },
          separator,
          { role: 'togglefullscreen', label: labels.fullscreen },
          separator,
          ...(['increaseFontSize', 'decreaseFontSize', 'resetFontSize'] as const).map(
            fontAction => ({
              id: `view.${fontAction}`,
              label: labels[fontAction],
              click: this.dispatch(FONT_SIZE_ACTIONS[fontAction]),
            })
          ),
        ],
      },
      {
        id: 'window',
        role: mac ? 'windowMenu' : undefined,
        label: labels.window,
        submenu: [
          { role: 'minimize', label: labels.minimize },
          {
            id: 'window.close',
            label: labels.close,
            click: () => this.withWindow(window => window.close()),
          },
          separator,
          {
            id: 'window.showMain',
            label: labels.showMain,
            click: this.run(this.dependencies.showMain),
          },
          ...(mac ? [separator, { role: 'front' as const }] : []),
        ],
      },
      {
        id: 'help',
        role: 'help',
        label: labels.help,
        submenu: [
          {
            id: 'help.project',
            label: labels.project,
            click: this.run(() =>
              this.dependencies.openExternal('https://github.com/wecode-ai/Wegent')
            ),
          },
          {
            id: 'help.issues',
            label: labels.issues,
            click: this.run(() =>
              this.dependencies.openExternal('https://github.com/wecode-ai/Wegent/issues')
            ),
          },
          separator,
          {
            id: 'developer',
            label: labels.developer,
            submenu: [
              {
                id: 'developer.devTools',
                label: labels.devTools,
                accelerator: mac ? 'Alt+Command+I' : 'Control+Shift+I',
                click: () => this.withWindow(this.dependencies.openDevTools),
              },
              {
                id: 'developer.commands',
                label: labels.commands,
                click: this.dispatch('developer-commands'),
              },
              {
                id: 'developer.logs',
                label: labels.logs,
                click: this.run(this.dependencies.openLogDirectory),
              },
            ],
          },
        ],
      },
    ]
  }
}
