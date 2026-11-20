import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
export function isPopoutWindowRuntime() {
  return isElectronRuntime() && getDesktopWindowLabel() === 'popout-window'
}
