import { GitHostingSettingsPage } from '@/components/settings/GitHostingSettingsPage'
import { WorktreesSettingsPage } from '@/components/settings/WorktreesSettingsPage'
import type { WeworkDshSettingsModuleProps } from '@/features/dsh-runtime/DshSettingsSurface'

export default function GitSettingsPage({
  page,
  services,
  devices,
  onBack,
  onOpenRuntimeTask,
  onRefreshWorkLists,
}: WeworkDshSettingsModuleProps) {
  if (page.id === 'git-hosting') {
    return <GitHostingSettingsPage />
  }
  if (page.id === 'worktrees') {
    return (
      <WorktreesSettingsPage
        api={services?.runtimeWorkApi}
        devices={devices}
        onOpenRuntimeTask={onOpenRuntimeTask}
        onRefreshWorkLists={onRefreshWorkLists}
        onLeaveSettings={onBack}
      />
    )
  }
  return null
}
