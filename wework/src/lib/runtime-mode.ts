import { getRuntimeConfig } from '@/config/runtime'
import { isTauriRuntime } from '@/lib/runtime-environment'

export function isLocalFirstAppRuntime(): boolean {
  return getRuntimeConfig().runtimeMode === 'local-first' && isTauriRuntime()
}
