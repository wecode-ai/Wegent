import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { MobileWorkbenchLayout } from '@/components/layout/MobileWorkbenchLayout'
import { useIsMobile } from '@/hooks/useIsMobile'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { shouldUseMobileWorkbenchLayout } from '@/lib/workbench-layout-mode'
import { SystemDragBridge } from '@/features/system-drag/SystemDragBridge'

interface WorkbenchPageProps {
  routeActive?: boolean
  surfaceKind?: 'task' | 'board'
}

export function WorkbenchPage({ routeActive = true, surfaceKind }: WorkbenchPageProps) {
  return (
    <>
      {isElectronRuntime() && routeActive ? <SystemDragBridge /> : null}
      {surfaceKind === 'board' ? (
        <DesktopWorkbenchLayout routeActive={routeActive} surfaceKind="board" />
      ) : (
        <TaskWorkbenchPage routeActive={routeActive} surfaceKind={surfaceKind} />
      )}
    </>
  )
}

function TaskWorkbenchPage({ routeActive = true, surfaceKind }: WorkbenchPageProps) {
  const isDesktop = isElectronRuntime()

  return (
    <WorkbenchPageLayout
      routeActive={routeActive}
      surfaceKind={surfaceKind}
      isDesktop={isDesktop}
    />
  )
}

interface WorkbenchPageLayoutProps extends WorkbenchPageProps {
  isDesktop?: boolean
}

function WorkbenchPageLayout({
  routeActive = true,
  surfaceKind,
  isDesktop = isElectronRuntime(),
}: WorkbenchPageLayoutProps) {
  const isMobileViewport = useIsMobile()
  return shouldUseMobileWorkbenchLayout({ isMobileViewport, isDesktop }) ? (
    <MobileWorkbenchLayout />
  ) : (
    <DesktopWorkbenchLayout routeActive={routeActive} surfaceKind={surfaceKind} />
  )
}
