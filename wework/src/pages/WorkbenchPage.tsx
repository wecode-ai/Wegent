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
import { EMPTY_RUNTIME_TASK_REMINDERS } from '@/features/workbench/runtimeTaskReminders'
import { buildTrayMenuTaskGroups } from '@/tauri/trayMenuState'
import { syncTrayMenuState } from '@/tauri/trayNavigation'
import {
  consumePluginTrialInput,
  FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT,
} from '@/features/plugins/pluginTrial'

interface PendingPluginTrialInjection {
  input: string
  targetStandaloneChatKey: number
}

export function WorkbenchPage() {
  const isMobileViewport = useIsMobile()
  const isTauri = isTauriRuntime()
  const { state, runtimeTaskReminders, projectChat, startStandaloneChat } = useWorkbench()
  const taskReminders = runtimeTaskReminders ?? EMPTY_RUNTIME_TASK_REMINDERS
  const { trayUnreadEnabled, trayRunningEnabled, trayUsageEnabled } = taskReminders.preferences
  const [codexUsage, setCodexUsage] = useState<CodexUsageDisplay>(() => emptyCodexUsageDisplay())
  const [pendingPluginTrialInjection, setPendingPluginTrialInjection] =
    useState<PendingPluginTrialInjection | null>(null)
  const trayMenuTaskGroups = useMemo(
    () =>
      buildTrayMenuTaskGroups(state.runtimeWork, {
        reminders: taskReminders,
        showUnread: trayUnreadEnabled,
        showRunning: trayRunningEnabled,
      }),
    [state.runtimeWork, taskReminders, trayUnreadEnabled, trayRunningEnabled]
  )
  const trayTooltip = useMemo(() => {
    const parts = []
    if (trayRunningEnabled && taskReminders.hasRunningTasks) {
      parts.push(i18nLabel('running'))
    }
    if (trayUnreadEnabled && taskReminders.unreadCount > 0) {
      parts.push(i18nLabel('unread', taskReminders.unreadCount))
    }
    if (trayUsageEnabled && codexUsage.tooltip) parts.push(codexUsage.tooltip)
    return parts.length > 0 ? parts.join('\n') : trayUsageEnabled ? codexUsage.tooltip : null
  }, [
    codexUsage.tooltip,
    taskReminders.hasRunningTasks,
    taskReminders.unreadCount,
    trayRunningEnabled,
    trayUnreadEnabled,
    trayUsageEnabled,
  ])

  useEffect(() => {
    syncTrayMenuState(trayMenuTaskGroups, undefined, {
      title: trayUsageEnabled ? codexUsage.trayTitle : null,
      tooltip: trayTooltip,
    })
  }, [trayMenuTaskGroups, codexUsage.trayTitle, trayTooltip, trayUsageEnabled])

  useEffect(() => {
    const trialInput = consumePluginTrialInput()
    if (!trialInput) return
    const targetStandaloneChatKey = state.standaloneChatKey + 1
    const frame = window.requestAnimationFrame(() => {
      setPendingPluginTrialInjection({
        input: trialInput,
        targetStandaloneChatKey,
      })
      startStandaloneChat()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [projectChat.input, startStandaloneChat, state.currentRuntimeTask, state.standaloneChatKey])

  useEffect(() => {
    if (!pendingPluginTrialInjection) return
    if (state.currentRuntimeTask) {
      return
    }
    if (state.standaloneChatKey !== pendingPluginTrialInjection.targetStandaloneChatKey) {
      return
    }
    projectChat.setInput(pendingPluginTrialInjection.input)
    const frame = window.requestAnimationFrame(() => {
      setPendingPluginTrialInjection(null)
      window.dispatchEvent(
        new CustomEvent(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, {
          detail: { expectedValue: pendingPluginTrialInjection.input },
        })
      )
    })
    return () => window.cancelAnimationFrame(frame)
  }, [pendingPluginTrialInjection, projectChat, state.currentRuntimeTask, state.standaloneChatKey])

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

function i18nLabel(type: 'running' | 'unread', count?: number) {
  const language = navigator.language || ''
  const english = language.toLowerCase().startsWith('en')
  if (type === 'running') return english ? 'Tasks running' : '有任务运行中'
  return english ? `${count ?? 0} unread completed` : `${count ?? 0} 个未读完成任务`
}
