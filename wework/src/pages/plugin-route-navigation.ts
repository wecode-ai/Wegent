import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import type { RuntimeTaskAddress } from '@/types/api'

type OpenRuntimeTask = (address: RuntimeTaskAddress) => Promise<void>

export function createPluginRouteRuntimeTaskOpener(openRuntimeTask: OpenRuntimeTask) {
  return async (address: RuntimeTaskAddress) => {
    await openRuntimeTask(address)
    navigateTo(buildRuntimeTaskRoute(address))
  }
}
