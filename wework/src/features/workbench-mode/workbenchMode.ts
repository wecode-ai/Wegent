import { restartCoreDsh } from '@/features/dsh-plugins/coreDshPlugins'
import {
  updateAppPreferences,
  type AppPreferences,
  type WorkbenchMode,
} from '@/desktop/appPreferences'

export const MODE_MANAGED_GIT_PLUGIN = '@wegent/dsh-ui-git'

interface WorkbenchModeDependencies {
  restartPlugins: () => Promise<void>
  updatePreferences: (patch: { workbenchMode: WorkbenchMode }) => Promise<AppPreferences>
}

const defaultDependencies: WorkbenchModeDependencies = {
  restartPlugins: restartCoreDsh,
  updatePreferences: updateAppPreferences,
}

export async function changeWorkbenchMode(
  currentMode: WorkbenchMode,
  nextMode: WorkbenchMode,
  dependencies: WorkbenchModeDependencies = defaultDependencies
): Promise<AppPreferences> {
  if (currentMode === nextMode) {
    return dependencies.updatePreferences({ workbenchMode: nextMode })
  }

  const preferences = await dependencies.updatePreferences({ workbenchMode: nextMode })
  try {
    await dependencies.restartPlugins()
    return preferences
  } catch (error) {
    await dependencies.updatePreferences({ workbenchMode: currentMode }).catch(() => undefined)
    throw error
  }
}
