import { useMemo } from 'react'
import { DshSlotSurface } from '@/features/dsh-runtime/DshSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import type {
  WeworkWorkspaceScope,
  WeworkWorkspaceSidebarTab,
  WeworkWorkspaceSidebarTabDescriptor,
} from './rightWorkspaceDshSidebar'

interface DshSidebarExtensionPanelProps {
  descriptor: WeworkWorkspaceSidebarTabDescriptor
  scope: WeworkWorkspaceScope
  tab: WeworkWorkspaceSidebarTab
  visible: boolean
}

export function DshSidebarExtensionPanel({
  descriptor,
  scope,
  tab,
  visible,
}: DshSidebarExtensionPanelProps) {
  const props = useMemo(
    () => ({
      scope,
      tab,
      visible,
    }),
    [scope, tab, visible]
  )
  return (
    <DshSlotSurface
      className="flex min-h-0 flex-1 flex-col"
      enabled={visible}
      entryId={descriptor.id}
      props={props}
      slot={WEWORK_DSH_SLOTS.workspaceSidebarTab}
      testId={`dsh-sidebar-extension-surface-${descriptor.id}`}
    />
  )
}
