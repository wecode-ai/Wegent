/**
 * Single source of truth for the Wework application menu.
 *
 * The Electron host renders the native menu from this declaration and the
 * renderer executes its actions. Keeping item ids, actions, and their
 * visibility conditions together prevents the menu structure, the action
 * dispatch, and the condition checks from drifting apart.
 *
 * Rules for adding menu items (see wework/AGENTS.md):
 * - Reuse an existing product action; never add a second navigation path.
 * - Put the item into an existing top-level menu.
 * - Declare the capability it needs so it can be hidden when unavailable.
 */

/** Actions the Electron host dispatches to the focused workbench window. */
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

/**
 * Capabilities a menu item can require. The renderer reports the current
 * values and the host hides any item whose capability is false.
 *
 * Capabilities map to state the UI already tracks; they must never be
 * invented for the menu alone.
 */
export const APPLICATION_MENU_CAPABILITIES = {
  /** A closable (non-fixed) workspace tab exists. */
  canCloseTab: 'canCloseTab',
  /** The active surface is a task workspace. */
  taskSurface: 'taskSurface',
} as const

export type ApplicationMenuCapability =
  (typeof APPLICATION_MENU_CAPABILITIES)[keyof typeof APPLICATION_MENU_CAPABILITIES]

export type ApplicationMenuCapabilityState = Partial<Record<ApplicationMenuCapability, boolean>>

export const EMPTY_APPLICATION_MENU_CAPABILITIES: ApplicationMenuCapabilityState = {}
