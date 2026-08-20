import { baseWorkbenchProfile } from '@/plugins/base-profile'

import { WorkbenchPluginRuntime } from './runtime'

let runtime = new WorkbenchPluginRuntime()
let initialization = runtime.initialize(baseWorkbenchProfile)

export async function initializeWorkbenchPluginRuntime(): Promise<WorkbenchPluginRuntime> {
  await initialization
  return runtime
}

export function getWorkbenchPluginRuntime(): WorkbenchPluginRuntime {
  return runtime
}

export async function disposeWorkbenchPluginRuntime(): Promise<void> {
  const current = runtime
  await current.dispose()
  runtime = new WorkbenchPluginRuntime()
  initialization = runtime.initialize(baseWorkbenchProfile)
}
