/**
 * Actions and capabilities used by the Wework native application menu.
 *
 * The Electron host declares the native menu structure, item ids, and labels
 * in `electron/src/host/application-menu.ts`; the renderer executes the actions
 * it dispatches. Actions and capabilities are declared in both projects, and
 * `applicationMenuContract.test.ts` fails when those declarations drift. Item
 * ids exist only in the host declaration and are covered by the
 * `application-menu` desktop E2E checkpoint.
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
  openProcessExplorer: 'open-process-explorer',
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
  /** The active workspace tab can be closed (it is not fixed). */
  canCloseTab: 'canCloseTab',
  /** The active surface is a task workspace. */
  taskSurface: 'taskSurface',
} as const

export type ApplicationMenuCapability =
  (typeof APPLICATION_MENU_CAPABILITIES)[keyof typeof APPLICATION_MENU_CAPABILITIES]

export type ApplicationMenuCapabilityState = Partial<Record<ApplicationMenuCapability, boolean>>
