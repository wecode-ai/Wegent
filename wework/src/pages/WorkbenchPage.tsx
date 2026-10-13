import { lazy, Suspense, useEffect, useMemo } from 'react'
import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { shouldUseMobileWorkbenchLayout } from '@/lib/workbench-layout-mode'
import { EMPTY_RUNTIME_TASK_REMINDERS } from '@/features/workbench/runtimeTaskReminders'
import { buildTrayMenuTaskGroups } from '@/desktop/trayMenuState'
import { syncTrayMenuState } from '@/desktop/trayNavigation'
import { useRuntimeTaskRouteRestoration } from '@/features/workbench/useRuntimeTaskRouteRestoration'
import { useRuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import { SystemDragBridge } from '@/features/system-drag/SystemDragBridge'

const MobileWorkbenchLayout = lazy(() =>
  import('@/components/layout/MobileWorkbenchLayout').then(module => ({
    default: module.MobileWorkbenchLayout,
  }))
)

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
  const { state, runtimeTaskReminders } = useWorkbench()
  const lifecycle = useRuntimeTaskLifecycleStoreSnapshot()
  useRuntimeTaskRouteRestoration(routeActive)
  const taskReminders = runtimeTaskReminders ?? EMPTY_RUNTIME_TASK_REMINDERS
  const { trayUnreadEnabled, trayRunningEnabled } = taskReminders.preferences
  const taskSurfaceActive = routeActive
  const trayMenuTaskGroups = useMemo(
    () =>
      buildTrayMenuTaskGroups(state.runtimeWork, {
        reminders: taskReminders,
        lifecycle,
        showUnread: trayUnreadEnabled,
        showRunning: trayRunningEnabled,
      }),
    [lifecycle, state.runtimeWork, taskReminders, trayUnreadEnabled, trayRunningEnabled]
  )
  const trayTooltip = useMemo(() => {
    if (trayUnreadEnabled && taskReminders.unreadCount > 0) {
      return unreadLabel(taskReminders.unreadCount)
    }
    return null
  }, [taskReminders.unreadCount, trayUnreadEnabled])

  useEffect(() => {
    if (!taskSurfaceActive) return
    syncTrayMenuState(trayMenuTaskGroups, undefined, {
      title: null,
      tooltip: trayTooltip,
    })
  }, [taskSurfaceActive, trayMenuTaskGroups, trayTooltip])

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
    <Suspense fallback={null}>
      <MobileWorkbenchLayout />
    </Suspense>
  ) : (
    <DesktopWorkbenchLayout routeActive={routeActive} surfaceKind={surfaceKind} />
  )
}

function unreadLabel(count: number) {
  const language = navigator.language || ''
  const english = language.toLowerCase().startsWith('en')
  return english ? `${count} unread completed` : `${count} 个未读完成任务`
}
