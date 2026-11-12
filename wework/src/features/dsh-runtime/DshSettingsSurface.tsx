import { createElement, Suspense, use, type ComponentType } from 'react'

import type { WeworkDshSettingsContext, WeworkDshSettingsPage } from './dshSettings'
import { getLoadedDshUiModule, importDshUiModule } from './dshUiModules'
import { DshSurfaceLoading } from './DshSurfaceLoading'

export interface WeworkDshSettingsModuleProps extends WeworkDshSettingsContext {
  autoOpenAddCloudDeviceDialog?: boolean
  page: WeworkDshSettingsPage
}

interface DshSettingsModule {
  default: ComponentType<WeworkDshSettingsModuleProps>
}

function DshSettingsModuleLoader({
  module,
  ...props
}: WeworkDshSettingsModuleProps & { module: string }) {
  const cached = getLoadedDshUiModule<DshSettingsModule>(module)
  const loaded = cached ?? use(importDshUiModule<DshSettingsModule>(module))
  return createElement(loaded.default, props)
}

export function DshSettingsSurface(props: WeworkDshSettingsModuleProps) {
  const module = props.page.module
  if (!module) return null
  return (
    <Suspense fallback={<DshSurfaceLoading testId="dsh-settings-loading" />}>
      <DshSettingsModuleLoader {...props} module={module} />
    </Suspense>
  )
}
