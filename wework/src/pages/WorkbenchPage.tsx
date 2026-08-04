import { useEffect, useMemo, useState } from 'react'
import {
  emptyCodexUsageDisplay,
  getLocalCodexUsageDisplay,
  type CodexUsageDisplay,
} from '@/api/local/codexUsage'
import {
  emptyWegentUsageDisplay,
  getWegentUsageDisplay,
  type WegentUsageDisplay,
} from '@/api/wegentUsage'
import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { MobileWorkbenchLayout } from '@/components/layout/MobileWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { shouldUseMobileWorkbenchLayout } from '@/lib/workbench-layout-mode'
import { EMPTY_RUNTIME_TASK_REMINDERS } from '@/features/workbench/runtimeTaskReminders'
import { buildTrayMenuTaskGroups } from '@/tauri/trayMenuState'
import { syncTrayMenuState } from '@/tauri/trayNavigation'
import { buildTrayUsageTitle } from '@/tauri/trayUsageTitle'
import { useRuntimeTaskRouteRestoration } from '@/features/workbench/useRuntimeTaskRouteRestoration'
import { useRuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'

interface WorkbenchPageProps {
  routeActive?: boolean
}

export function WorkbenchPage({ routeActive = true }: WorkbenchPageProps) {
  const isMobileViewport = useIsMobile()
  const isTauri = isTauriRuntime()
  const cloudConnection = useOptionalCloudConnection()
  const { state, runtimeTaskReminders } = useWorkbench()
  const lifecycle = useRuntimeTaskLifecycleStoreSnapshot()
  useRuntimeTaskRouteRestoration(routeActive)
  const taskReminders = runtimeTaskReminders ?? EMPTY_RUNTIME_TASK_REMINDERS
  const { trayUnreadEnabled, trayRunningEnabled, trayUsageEnabled, trayWegentUsageEnabled } =
    taskReminders.preferences
  const [codexUsage, setCodexUsage] = useState<CodexUsageDisplay>(() => emptyCodexUsageDisplay())
  const [wegentUsage, setWegentUsage] = useState<WegentUsageDisplay>(() =>
    emptyWegentUsageDisplay()
  )
  const showTrayCodexUsage = trayUsageEnabled && codexUsage.status === 'available'
  const showTrayWegentUsage =
    trayWegentUsageEnabled && cloudConnection.isConnected && wegentUsage.status === 'available'
  const trayUsageTitle = buildTrayUsageTitle({
    codex: showTrayCodexUsage ? codexUsage.trayTitle : null,
    compactCodex: showTrayCodexUsage ? compactCodexTrayTitle(codexUsage) : null,
    wegent: showTrayWegentUsage ? wegentUsage.trayTitle : null,
  })
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
    const parts = []
    if (trayMenuTaskGroups.hasRunningTasks) {
      parts.push(i18nLabel('running'))
    }
    if (trayUnreadEnabled && taskReminders.unreadCount > 0) {
      parts.push(i18nLabel('unread', taskReminders.unreadCount))
    }
    if (showTrayCodexUsage) parts.push(codexUsage.tooltip)
    if (showTrayWegentUsage) parts.push(wegentUsage.tooltip)
    return parts.length > 0 ? parts.join('\n') : null
  }, [
    codexUsage.tooltip,
    wegentUsage.tooltip,
    taskReminders.unreadCount,
    trayMenuTaskGroups.hasRunningTasks,
    trayUnreadEnabled,
    showTrayCodexUsage,
    showTrayWegentUsage,
  ])

  useEffect(() => {
    syncTrayMenuState(trayMenuTaskGroups, undefined, {
      title: trayUsageTitle,
      tooltip: trayTooltip,
    })
  }, [trayMenuTaskGroups, trayTooltip, trayUsageTitle])

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

  useEffect(() => {
    if (!isTauri || !cloudConnection.isConnected) {
      return
    }

    let cancelled = false
    const refreshUsage = () => {
      getWegentUsageDisplay({
        isConnected: cloudConnection.isConnected,
        apiBaseUrl: cloudConnection.apiBaseUrl,
        token: cloudConnection.token,
      })
        .then(usage => {
          if (!cancelled) {
            setWegentUsage(usage)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setWegentUsage(emptyWegentUsageDisplay())
          }
        })
    }

    refreshUsage()
    const interval = window.setInterval(refreshUsage, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [
    cloudConnection.apiBaseUrl,
    cloudConnection.isConnected,
    cloudConnection.serviceKey,
    cloudConnection.token,
    isTauri,
  ])

  return shouldUseMobileWorkbenchLayout({ isMobileViewport, isTauri }) ? (
    <MobileWorkbenchLayout />
  ) : (
    <DesktopWorkbenchLayout routeActive={routeActive} />
  )
}

function compactCodexTrayTitle(usage: CodexUsageDisplay): string {
  const percents = [usage.fiveHour.percent, usage.sevenDay.percent].filter(
    (percent): percent is number => percent !== null
  )
  return `Codex  ${percents.length > 0 ? `${Math.min(...percents)}%` : '--'}`
}

function i18nLabel(type: 'running' | 'unread', count?: number) {
  const language = navigator.language || ''
  const english = language.toLowerCase().startsWith('en')
  if (type === 'running') return english ? 'Tasks running' : '有任务运行中'
  return english ? `${count ?? 0} unread completed` : `${count ?? 0} 个未读完成任务`
}
