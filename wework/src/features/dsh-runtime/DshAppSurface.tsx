import { createElement, Suspense, use, type ComponentType } from 'react'
import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import type { WeworkDshApp } from './dshApps'
import { DshSlotSurface } from './DshSlotSurface'
import { WEWORK_DSH_SLOTS } from './dshUiSlots'
import { getLoadedDshUiModule, importDshUiModule } from './dshUiModules'

export interface WeworkDshAppModuleProps {
  active: boolean
  app: WeworkDshApp
  tab: WorkspaceTab
}

interface DshAppModule {
  default: ComponentType<WeworkDshAppModuleProps>
}

function DshAppModuleLoader({ module, ...props }: WeworkDshAppModuleProps & { module: string }) {
  const cached = getLoadedDshUiModule<DshAppModule>(module)
  const loaded = cached ?? use(importDshUiModule<DshAppModule>(module))
  return createElement(loaded.default, props)
}

export function DshAppSurface({
  active,
  app,
  tab,
}: {
  active: boolean
  app: WeworkDshApp
  tab: WorkspaceTab
}) {
  if (app.module) {
    return (
      <Suspense fallback={<div className="h-full min-h-0" data-testid="dsh-app-loading" />}>
        <DshAppModuleLoader active={active} app={app} module={app.module} tab={tab} />
      </Suspense>
    )
  }
  return (
    <DshSlotSurface
      className="h-full min-h-0"
      entryId={app.id}
      props={{ tab, visible: active }}
      slot={WEWORK_DSH_SLOTS.app}
      testId={`dsh-app-surface-${app.id}`}
    />
  )
}
