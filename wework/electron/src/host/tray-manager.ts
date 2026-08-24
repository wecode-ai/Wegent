export interface TrayMenuTaskItem {
  id: string
  title: string
  projectName: string
}

export interface TrayMenuState {
  language: string
  usageTitle: string | null
  usageTooltip: string | null
  running: TrayMenuTaskItem[]
  runningMore: TrayMenuTaskItem[]
  unread: TrayMenuTaskItem[]
  unreadMore: TrayMenuTaskItem[]
  pinned: TrayMenuTaskItem[]
  pinnedMore: TrayMenuTaskItem[]
  recent: TrayMenuTaskItem[]
  recentMore: TrayMenuTaskItem[]
  hasRunningTasks: boolean
  showRunningStatus: boolean
  runningCount: number
  activeTaskIds: string[] | null
  unreadCount: number
}

export type TrayAction =
  | { type: 'open-app'; source: 'tray-icon' | 'tray-menu' }
  | { type: 'open-settings'; source: 'tray-menu' }
  | { type: 'open-task'; source: 'tray-menu'; taskId: string }
  | { type: 'quit-app'; source: 'tray-menu' }

export type TrayActivation =
  | { type: 'click' }
  | { type: 'double-click' }
  | { type: 'menu-item'; menuItemId: string }

export interface TrayMenuTemplateItem {
  id?: string
  label?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
  submenu?: TrayMenuTemplateItem[]
  click?: () => void
}

export interface TrayAdapter<TMenu = unknown> {
  on(event: 'click' | 'double-click', listener: () => void): void
  setContextMenu(menu: TMenu): void
  setToolTip(tooltip: string): void
  setTitle?(title: string): void
  destroy(): void
}

export interface TrayManagerDependencies<TMenu = unknown> {
  createTray: () => TrayAdapter<TMenu>
  buildMenu: (template: TrayMenuTemplateItem[]) => TMenu
  dispatchAction: (action: TrayAction) => void
  platform?: NodeJS.Platform
  defaultTooltip?: string
}

export interface TrayMenuSnapshotItem {
  id?: string
  label?: string
  enabled?: boolean
  type: 'normal' | 'separator' | 'submenu'
  submenu?: TrayMenuSnapshotItem[]
}

export interface TraySnapshot {
  created: boolean
  title: string | null
  titleSupported: boolean
  tooltip: string
  menu: TrayMenuSnapshotItem[]
}

interface TrayMenuLabels {
  running: string
  unread: string
  pinned: string
  recent: string
  untitledTask: string
  noPinnedTasks: string
  noTasks: string
  more: string
  open: string
  settings: string
  quit: string
}

interface TrayTaskSection {
  id: string
  label: string
  emptyLabel: string
  items: TrayMenuTaskItem[]
  moreItems: TrayMenuTaskItem[]
  alwaysVisible: boolean
}

const OPEN_MENU_ITEM_ID = 'open'
const SETTINGS_MENU_ITEM_ID = 'settings'
const QUIT_MENU_ITEM_ID = 'quit'
const TASK_MENU_ITEM_PREFIX = 'task:'

const EMPTY_STATE: TrayMenuState = {
  language: 'zh-CN',
  usageTitle: null,
  usageTooltip: null,
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
}

const ZH_CN_LABELS: TrayMenuLabels = {
  running: '运行中',
  unread: '未读完成',
  pinned: '置顶',
  recent: '任务',
  untitledTask: '未命名任务',
  noPinnedTasks: '暂无置顶任务',
  noTasks: '暂无任务',
  more: '更多',
  open: '打开应用',
  settings: '设置',
  quit: '退出应用',
}

const EN_LABELS: TrayMenuLabels = {
  running: 'Running',
  unread: 'Unread Completed',
  pinned: 'Pinned',
  recent: 'Tasks',
  untitledTask: 'Untitled Task',
  noPinnedTasks: 'No Pinned Tasks',
  noTasks: 'No Tasks',
  more: 'More',
  open: 'Open App',
  settings: 'Settings',
  quit: 'Quit App',
}

function labelsForLanguage(language: string): TrayMenuLabels {
  return language.trim().toLowerCase().startsWith('en') ? EN_LABELS : ZH_CN_LABELS
}

function normalizedTaskLabel(item: TrayMenuTaskItem, untitledTask: string): string {
  const title = item.title.trim()
  const projectName = item.projectName.trim()
  if (!title) {
    return untitledTask
  }
  return projectName ? `${title} - ${projectName}` : title
}

function toSnapshotItem(item: TrayMenuTemplateItem): TrayMenuSnapshotItem {
  if (item.type === 'separator') {
    return { type: 'separator' }
  }
  if (item.submenu) {
    return {
      id: item.id,
      label: item.label,
      enabled: item.enabled,
      type: 'submenu',
      submenu: item.submenu.map(toSnapshotItem),
    }
  }
  return {
    id: item.id,
    label: item.label,
    enabled: item.enabled,
    type: 'normal',
  }
}

export class ElectronTrayManager<TMenu = unknown> {
  private readonly platform: NodeJS.Platform
  private readonly defaultTooltip: string
  private tray: TrayAdapter<TMenu> | null = null
  private state: TrayMenuState = EMPTY_STATE
  private menuTemplate: TrayMenuTemplateItem[] = []
  private menuActions = new Map<string, TrayAction>()

  constructor(private readonly dependencies: TrayManagerDependencies<TMenu>) {
    this.platform = dependencies.platform ?? process.platform
    this.defaultTooltip = dependencies.defaultTooltip ?? 'WeWork'
  }

  create(): void {
    if (this.tray) {
      return
    }

    const tray = this.dependencies.createTray()
    tray.on('click', () => {
      this.activate({ type: 'click' })
    })
    tray.on('double-click', () => {
      this.activate({ type: 'double-click' })
    })
    this.tray = tray
    this.applyState()
  }

  destroy(): void {
    if (!this.tray) {
      return
    }

    this.tray.destroy()
    this.tray = null
  }

  setState(state: TrayMenuState): void {
    this.state = state
    if (this.tray) {
      this.applyState()
    } else {
      this.rebuildMenu()
    }
  }

  activate(activation: TrayActivation): boolean {
    if (activation.type === 'click' || activation.type === 'double-click') {
      this.dependencies.dispatchAction({ type: 'open-app', source: 'tray-icon' })
      return true
    }

    const action = this.menuActions.get(activation.menuItemId)
    if (!action) {
      return false
    }
    this.dependencies.dispatchAction(action)
    return true
  }

  snapshot(): TraySnapshot {
    return {
      created: this.tray !== null,
      title: this.state.usageTitle,
      titleSupported: this.platform === 'darwin',
      tooltip: this.state.usageTooltip?.trim() || this.defaultTooltip,
      menu: this.menuTemplate.map(toSnapshotItem),
    }
  }

  private applyState(): void {
    const tray = this.tray
    if (!tray) {
      return
    }

    this.rebuildMenu()
    tray.setContextMenu(this.dependencies.buildMenu(this.menuTemplate))
    tray.setToolTip(this.state.usageTooltip?.trim() || this.defaultTooltip)
    if (this.platform === 'darwin' && tray.setTitle) {
      tray.setTitle(this.state.usageTitle?.trim() ?? '')
    }
  }

  private rebuildMenu(): void {
    const labels = labelsForLanguage(this.state.language)
    const actions = new Map<string, TrayAction>()
    const sections: TrayTaskSection[] = [
      {
        id: 'unread',
        label: labels.unread,
        emptyLabel: '',
        items: this.state.unread,
        moreItems: this.state.unreadMore,
        alwaysVisible: false,
      },
      {
        id: 'running',
        label: labels.running,
        emptyLabel: '',
        items: this.state.running,
        moreItems: this.state.runningMore,
        alwaysVisible: false,
      },
      {
        id: 'pinned',
        label: labels.pinned,
        emptyLabel: labels.noPinnedTasks,
        items: this.state.pinned,
        moreItems: this.state.pinnedMore,
        alwaysVisible: true,
      },
      {
        id: 'recent',
        label: labels.recent,
        emptyLabel: labels.noTasks,
        items: this.state.recent,
        moreItems: this.state.recentMore,
        alwaysVisible: true,
      },
    ]
    const template = sections.flatMap(section => this.buildTaskSection(section, labels, actions))

    this.appendActionItem(template, actions, OPEN_MENU_ITEM_ID, labels.open, {
      type: 'open-app',
      source: 'tray-menu',
    })
    template.push({ type: 'separator' })
    this.appendActionItem(template, actions, SETTINGS_MENU_ITEM_ID, labels.settings, {
      type: 'open-settings',
      source: 'tray-menu',
    })
    template.push({ type: 'separator' })
    this.appendActionItem(template, actions, QUIT_MENU_ITEM_ID, labels.quit, {
      type: 'quit-app',
      source: 'tray-menu',
    })

    this.menuActions = actions
    this.menuTemplate = template
  }

  private buildTaskSection(
    section: TrayTaskSection,
    labels: TrayMenuLabels,
    actions: Map<string, TrayAction>
  ): TrayMenuTemplateItem[] {
    if (!section.alwaysVisible && section.items.length === 0 && section.moreItems.length === 0) {
      return []
    }

    const result: TrayMenuTemplateItem[] = [
      {
        id: `heading:${section.id}`,
        label: section.label,
        enabled: false,
      },
    ]

    if (section.items.length === 0 && section.moreItems.length === 0) {
      result.push({
        id: `empty:${section.id}`,
        label: section.emptyLabel,
        enabled: false,
      })
    } else {
      for (const item of section.items) {
        result.push(this.buildTaskItem(item, labels, actions))
      }
      if (section.moreItems.length > 0) {
        result.push({
          id: `more:${section.id}`,
          label: labels.more,
          submenu: section.moreItems.map(item => this.buildTaskItem(item, labels, actions)),
        })
      }
    }

    result.push({ type: 'separator' })
    return result
  }

  private buildTaskItem(
    item: TrayMenuTaskItem,
    labels: TrayMenuLabels,
    actions: Map<string, TrayAction>
  ): TrayMenuTemplateItem {
    const menuItemId = `${TASK_MENU_ITEM_PREFIX}${item.id}`
    const action: TrayAction = {
      type: 'open-task',
      source: 'tray-menu',
      taskId: item.id,
    }
    actions.set(menuItemId, action)
    return {
      id: menuItemId,
      label: normalizedTaskLabel(item, labels.untitledTask),
      click: () => {
        this.activate({ type: 'menu-item', menuItemId })
      },
    }
  }

  private appendActionItem(
    template: TrayMenuTemplateItem[],
    actions: Map<string, TrayAction>,
    menuItemId: string,
    label: string,
    action: TrayAction
  ): void {
    actions.set(menuItemId, action)
    template.push({
      id: menuItemId,
      label,
      click: () => {
        this.activate({ type: 'menu-item', menuItemId })
      },
    })
  }
}
