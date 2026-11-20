import { isElectronRuntime } from '@/lib/runtime-environment'
import { useIsDesktop } from './useIsDesktop'

export function useIsMobile(): boolean {
  const isDesktopViewport = useIsDesktop()
  return !isElectronRuntime() && !isDesktopViewport
}
