import { createElement, Suspense, use, type ComponentType } from 'react'

import type { WeworkDshSettingsContext, WeworkDshSettingsPage } from './dshSettings'
import { getLoadedDshUiModule, importDshUiModule } from './dshUiModules'

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
  const loaded = use(importDshUiModule<DshSettingsModule>(module))
  return createElement(loaded.default, props)
}

export function DshSettingsSurface(props: WeworkDshSettingsModuleProps) {
  const module = props.page.module
  if (!module) return null
  const loaded = getLoadedDshUiModule<DshSettingsModule>(module)
  if (loaded) return createElement(loaded.default, props)
  return (
    <Suspense fallback={<div data-testid="dsh-settings-loading" />}>
      <DshSettingsModuleLoader {...props} module={module} />
    </Suspense>
  )
}
