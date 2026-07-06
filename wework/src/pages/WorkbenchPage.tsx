import { useEffect, useMemo, useState } from 'react'
import {
  emptyCodexUsageDisplay,
  getLocalCodexUsageDisplay,
  type CodexUsageDisplay,
} from '@/api/local/codexUsage'
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
  const [codexUsage, setCodexUsage] = useState<CodexUsageDisplay>(() => emptyCodexUsageDisplay())
  const trayMenuTaskGroups = useMemo(
    () => buildTrayMenuTaskGroups(state.runtimeWork),
    [state.runtimeWork]
  )

  useEffect(() => {
    syncTrayMenuState(trayMenuTaskGroups, undefined, {
      title: codexUsage.trayTitle,
      tooltip: codexUsage.tooltip,
    })
  }, [trayMenuTaskGroups, codexUsage])

  useEffect(() => {
    if (!isTauri) {
      return
    }

    let cancelled = false
    const refreshUsage = () => {
      getLocalCodexUsageDisplay()
        .then(usage => {
          if (!cancelled) {
            setCodexUsage(usage)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCodexUsage(emptyCodexUsageDisplay())
          }
        })
    }

    refreshUsage()
    const interval = window.setInterval(refreshUsage, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [isTauri])

  return shouldUseMobileWorkbenchLayout({ isMobileViewport, isTauri }) ? (
    <MobileWorkbenchLayout />
  ) : (
    <DesktopWorkbenchLayout />
  )
}
