import { useCallback } from 'react'
import {
  useRuntimeTaskLifecycleSelection,
  type RuntimeTaskLifecycleSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'
import { isRuntimeTaskExecutionRunning } from '@/features/workbench/runtimeTaskLifecycle/projection'
import { connectionEventSubscriptions } from '@/lib/runtime-connection-events'
import { preferredEventSubscription } from '@/lib/sidebar-event-state'
import type { RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'

function selectSidebarRowStatus(
  lifecycle: RuntimeTaskLifecycleSnapshot | null,
  task: RuntimeTaskSummary
) {
  const eventTask = lifecycle?.task ?? task
  const subscriptions = connectionEventSubscriptions(
    eventTask.runtimeHandle?.connectionEventSubscriptions
  )
  const visibleSubscriptions =
    subscriptions.length > 0 && isRuntimeTaskExecutionRunning(eventTask)
      ? subscriptions.filter(item => item.status === 'pending' || item.status === 'resuming_goal')
      : subscriptions
  return {
    eventSubscription: preferredEventSubscription(visibleSubscriptions),
    hasActiveGoal: lifecycle?.goalStatus === 'active',
    showRunning: lifecycle?.derived.shouldShowSidebarRunning === true,
    showWaiting: lifecycle?.derived.shouldShowSidebarWaiting === true,
  }
}

type SidebarRowStatus = ReturnType<typeof selectSidebarRowStatus>

function sameSidebarRowStatus(left: SidebarRowStatus, right: SidebarRowStatus): boolean {
  return (
    left.eventSubscription === right.eventSubscription &&
    left.hasActiveGoal === right.hasActiveGoal &&
    left.showRunning === right.showRunning &&
    left.showWaiting === right.showWaiting
  )
}

export function useRuntimeTaskSidebarRowStatus(
  address: RuntimeTaskAddress,
  task: RuntimeTaskSummary
) {
  const selectStatus = useCallback(
    (lifecycle: RuntimeTaskLifecycleSnapshot | null) => selectSidebarRowStatus(lifecycle, task),
    [task]
  )
  return useRuntimeTaskLifecycleSelection(address, selectStatus, sameSidebarRowStatus)
}
