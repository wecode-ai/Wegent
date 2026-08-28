import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import { DshSlotSurface } from './DshSlotSurface'
import { WEWORK_DSH_SLOTS } from './dshUiSlots'
import { dshWorkspaceTabIdFromPath } from './dshWorkspaceTabs'

interface DshWorkspaceTabSurfaceProps {
  active: boolean
  path: string
  tab: WorkspaceTab
}

export function DshWorkspaceTabSurface({ active, path, tab }: DshWorkspaceTabSurfaceProps) {
  const id = dshWorkspaceTabIdFromPath(path)

  return (
    <DshSlotSurface
      className="h-full min-h-0"
      entryId={id ?? undefined}
      props={{ tab, visible: active }}
      slot={WEWORK_DSH_SLOTS.workspaceTab}
      testId={`dsh-workspace-tab-surface-${id ?? 'missing'}`}
    />
  )
}
