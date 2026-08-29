import { createElement, Suspense, use, useCallback, type ComponentType } from 'react'

import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { navigateTo } from '@/lib/navigation'
import { DshSlotSurface } from './DshSlotSurface'
import type { WeworkDshRoute } from './dshRoutes'
import { WEWORK_DSH_SLOTS } from './dshUiSlots'
import { getLoadedDshUiModule, importDshUiModule } from './dshUiModules'

interface DshRouteModuleProps {
  onNavigate?: (path: string) => void
  search?: string
}

interface DshRouteModule {
  default: ComponentType<DshRouteModuleProps>
}

function DshRouteModuleLoader({ module, ...props }: DshRouteModuleProps & { module: string }) {
  const cached = getLoadedDshUiModule<DshRouteModule>(module)
  const loaded = cached ?? use(importDshUiModule<DshRouteModule>(module))
  return createElement(loaded.default, props)
}

export function DshRouteSurface({
  route,
  search,
  workspaceTabId,
}: {
  route: WeworkDshRoute
  search: string
  workspaceTabId: string
}) {
  const workspaceTabs = useOptionalWorkspaceTabs()
  const onNavigate = useCallback(
    (path: string) => {
      if (workspaceTabs) {
        if (workspaceTabs.activeTabId === workspaceTabId) {
          workspaceTabs.updateActiveTab({ contentRoute: path })
          return
        }
        workspaceTabs.selectTab(workspaceTabId, { contentRoute: path })
        return
      }
      navigateTo(path)
    },
    [workspaceTabId, workspaceTabs]
  )

  if (route.module) {
    return (
      <Suspense fallback={<div className="h-full min-h-0" data-testid="dsh-route-loading" />}>
        <DshRouteModuleLoader module={route.module} onNavigate={onNavigate} search={search} />
      </Suspense>
    )
  }
  return (
    <DshSlotSurface
      className="h-full min-h-0"
      entryId={route.id}
      props={{ onNavigate, search }}
      slot={WEWORK_DSH_SLOTS.route}
      testId={`dsh-route-surface-${route.id}`}
    />
  )
}
