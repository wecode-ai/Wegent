import { useMemo } from 'react'
import { DshSlotSurface } from '@/features/dsh-runtime/DshSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useTranslation } from '@/hooks/useTranslation'
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
  const { t } = useTranslation('common')
  const props = useMemo(
    () => ({
      scope,
      tab,
      t,
      visible,
    }),
    [scope, t, tab, visible]
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
