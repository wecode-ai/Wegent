import { getRuntimeConfig } from '@/config/runtime'
import { isDesktopRuntime } from '@/lib/runtime-environment'

export function isLocalFirstAppRuntime(): boolean {
  return getRuntimeConfig().runtimeMode === 'local-first' && isDesktopRuntime()
}
