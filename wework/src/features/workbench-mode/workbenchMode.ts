import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import {
  emitAppPreferencesChanged,
  mergeAppPreferences,
  type AppPreferences,
  type WorkbenchMode,
} from '@/desktop/appPreferences'

export const MODE_MANAGED_GIT_PLUGIN = '@wegent/dsh-ui-git'
export const MODE_MANAGED_HOME_PLUGINS = new Set([
  '@wegent/dsh-ui-home-focus',
  '@wegent/dsh-ui-home-developer',
])

export async function changeWorkbenchMode(mode: WorkbenchMode): Promise<AppPreferences> {
  // The host owns persistence and restart scheduling. A renderer reload must
  // never roll back a mode whose restart was already accepted by the host.
  const preferences = mergeAppPreferences(
    await invokeDesktopHost('runtime.changeWorkbenchMode', { mode })
  )
  emitAppPreferencesChanged(preferences)
  return preferences
}
