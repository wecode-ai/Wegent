import type { CoreDshPluginManager } from './core-dsh-plugin-manager.js'

export type WorkbenchMode = 'focus' | 'developer'

export const MODE_MANAGED_GIT_PLUGIN = '@wegent/dsh-ui-git'
export const MODE_MANAGED_FOCUS_HOME_PLUGIN = '@wegent/dsh-ui-home-focus'
export const MODE_MANAGED_DEVELOPER_HOME_PLUGIN = '@wegent/dsh-ui-home-developer'

export function normalizeWorkbenchMode(value: unknown): WorkbenchMode {
  return value === 'focus' ? 'focus' : 'developer'
}

export async function applyWorkbenchModeToCorePlugins(
  mode: WorkbenchMode,
  plugins: Pick<CoreDshPluginManager, 'list' | 'setEnabled'>
): Promise<void> {
  const inventory = await plugins.list()
  const desiredStates = new Map([
    [MODE_MANAGED_GIT_PLUGIN, mode === 'developer'],
    [MODE_MANAGED_FOCUS_HOME_PLUGIN, mode === 'focus'],
    [MODE_MANAGED_DEVELOPER_HOME_PLUGIN, mode === 'developer'],
  ])
  for (const plugin of inventory) {
    const shouldEnable = desiredStates.get(plugin.name)
    if (shouldEnable !== undefined && plugin.enabled !== shouldEnable) {
      await plugins.setEnabled(plugin.name, shouldEnable)
    }
  }
}
