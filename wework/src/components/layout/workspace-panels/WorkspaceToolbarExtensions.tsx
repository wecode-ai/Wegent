import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { DshMenuActions } from '@/features/dsh-runtime/DshMenuActions'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import type { ProjectWithTasks } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '../DesktopTopBar'

interface WorkspaceToolbarExtensionsProps {
  currentProject: ProjectWithTasks | null
  environmentInfo: EnvironmentInfo
  workspaceTarget: WorkspaceTarget | null
}

export function WorkspaceToolbarExtensions({
  currentProject,
  environmentInfo,
  workspaceTarget,
}: WorkspaceToolbarExtensionsProps) {
  return (
    <>
      <DshMenuActions buttonClassName={DESKTOP_TOP_BAR_BUTTON_CLASS} location="workspace.toolbar" />
      <div className="contents" data-testid="workspace-toolbar-extension-actions">
        <DshContributionSlotSurface
          attachedClassName="contents"
          props={{ currentProject, environmentInfo, workspaceTarget }}
          slot={WEWORK_DSH_SLOTS.workspaceToolbarAction}
        />
      </div>
    </>
  )
}
