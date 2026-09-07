import type { CoreDshPluginManager } from './core-dsh-plugin-manager.js'

export type WorkbenchMode = 'focus' | 'developer'

export const MODE_MANAGED_GIT_PLUGIN = '@wegent/dsh-ui-git'

export function normalizeWorkbenchMode(value: unknown): WorkbenchMode {
  return value === 'focus' ? 'focus' : 'developer'
}

export async function applyWorkbenchModeToCorePlugins(
  mode: WorkbenchMode,
  plugins: Pick<CoreDshPluginManager, 'list' | 'setEnabled'>
): Promise<void> {
  const inventory = await plugins.list()
  const gitPlugin = inventory.find(plugin => plugin.name === MODE_MANAGED_GIT_PLUGIN)
  if (!gitPlugin) return

  const shouldEnableGit = mode === 'developer'
  if (gitPlugin.enabled !== shouldEnableGit) {
    await plugins.setEnabled(MODE_MANAGED_GIT_PLUGIN, shouldEnableGit)
  }
}
