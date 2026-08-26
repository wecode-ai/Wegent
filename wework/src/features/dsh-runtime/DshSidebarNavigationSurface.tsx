import { createElement, Suspense, use } from 'react'

import type {
  DshSidebarNavigationModule,
  WeworkDshSidebarNavigationModuleProps,
} from './dshSidebarNavigation'
import { importDshUiModule } from './dshUiModules'

function DshSidebarNavigationModuleLoader({
  module,
  ...props
}: WeworkDshSidebarNavigationModuleProps & { module: string }) {
  const loaded = use(importDshUiModule<DshSidebarNavigationModule>(module))
  return createElement(loaded.default, props)
}

export function DshSidebarNavigationSurface(props: WeworkDshSidebarNavigationModuleProps) {
  const module = props.item.module
  if (!module) return null
  return (
    <Suspense fallback={null}>
      <DshSidebarNavigationModuleLoader {...props} module={module} />
    </Suspense>
  )
}
