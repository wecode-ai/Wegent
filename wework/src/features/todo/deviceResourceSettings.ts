import type { DesktopSidebarAccountSettingsOptions } from '@/components/layout/DesktopSidebarAccount'

export function resolveDeviceResourceSettingsOptions(
  resourceId?: string,
  source?: 'local' | 'cloud'
): DesktopSidebarAccountSettingsOptions {
  if (source === 'local') return { settingsPage: 'execution-environments' }
  return {
    settingsPage: 'connections',
    autoOpenAddCloudDeviceDialog: !resourceId,
  }
}
