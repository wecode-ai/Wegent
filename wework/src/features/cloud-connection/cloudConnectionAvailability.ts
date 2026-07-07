import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'

export function isCloudConnectionUiAvailable(): boolean {
  return isLocalFirstAppRuntime()
}
