import { createElement, Suspense, use, type ComponentType } from 'react'

import { DshSlotSurface } from './DshSlotSurface'
import type { WeworkDshRoute } from './dshRoutes'
import { WEWORK_DSH_SLOTS } from './dshUiSlots'
import { importDshUiModule } from './dshUiModules'

interface DshRouteModuleProps {
  search?: string
}

interface DshRouteModule {
  default: ComponentType<DshRouteModuleProps>
}

function DshRouteModuleLoader({ module, ...props }: DshRouteModuleProps & { module: string }) {
  const loaded = use(importDshUiModule<DshRouteModule>(module))
  return createElement(loaded.default, props)
}

export function DshRouteSurface({ route, search }: { route: WeworkDshRoute; search: string }) {
  if (route.module) {
    return (
      <Suspense fallback={<div className="h-full min-h-0" data-testid="dsh-route-loading" />}>
        <DshRouteModuleLoader module={route.module} search={search} />
      </Suspense>
    )
  }
  return (
    <DshSlotSurface
      className="h-full min-h-0"
      entryId={route.id}
      props={{ search }}
      slot={WEWORK_DSH_SLOTS.route}
      testId={`dsh-route-surface-${route.id}`}
    />
  )
}
