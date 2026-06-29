import { useEffect, useMemo } from 'react'
import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { MobileWorkbenchLayout } from '@/components/layout/MobileWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { buildTrayMenuTaskGroups } from '@/tauri/trayMenuState'
import { syncTrayMenuState } from '@/tauri/trayNavigation'

export function WorkbenchPage() {
  const isMobile = useIsMobile()
  const { state } = useWorkbench()
  const trayMenuTaskGroups = useMemo(
    () => buildTrayMenuTaskGroups(state.runtimeWork),
    [state.runtimeWork]
  )

  useEffect(() => {
    syncTrayMenuState(trayMenuTaskGroups)
  }, [trayMenuTaskGroups])

  return isMobile ? <MobileWorkbenchLayout /> : <DesktopWorkbenchLayout />
}
