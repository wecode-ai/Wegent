import { useEffect, useMemo } from 'react'
import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { MobileWorkbenchLayout } from '@/components/layout/MobileWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { shouldUseMobileWorkbenchLayout } from '@/lib/workbench-layout-mode'
import { buildTrayMenuTaskGroups } from '@/tauri/trayMenuState'
import { syncTrayMenuState } from '@/tauri/trayNavigation'

export function WorkbenchPage() {
  const isMobileViewport = useIsMobile()
  const isTauri = isTauriRuntime()
  const { state } = useWorkbench()
  const trayMenuTaskGroups = useMemo(
    () => buildTrayMenuTaskGroups(state.runtimeWork),
    [state.runtimeWork]
  )

  useEffect(() => {
    syncTrayMenuState(trayMenuTaskGroups)
  }, [trayMenuTaskGroups])

  return shouldUseMobileWorkbenchLayout({ isMobileViewport, isTauri }) ? (
    <MobileWorkbenchLayout />
  ) : (
    <DesktopWorkbenchLayout />
  )
}
