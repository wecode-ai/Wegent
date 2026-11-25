import { isElectronRuntime } from '@/lib/runtime-environment'
import { useIsDesktop } from './useIsDesktop'

export function useIsMobile(): boolean {
  return !useIsDesktop(undefined, !isElectronRuntime())
}
