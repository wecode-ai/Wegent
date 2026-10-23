import type { RuntimeGoal, RuntimeTaskAddress } from '@/types/api'
import {
  getRuntimeConversationMetadata,
  setRuntimeConversationGoal,
} from '../runtimeConversationCache'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

export function syncRuntimeGoal(
  store: RuntimeTaskLifecycleStore,
  address: RuntimeTaskAddress,
  goal: RuntimeGoal | null
): RuntimeGoal | null {
  const previousGoal = getRuntimeConversationMetadata(address).goal
  const acceptedGoal = setRuntimeConversationGoal(address, goal)
  logRuntimeTaskCreateStage('goal-snapshot-reconciled', {
    taskId: address.taskId,
    previousThreadId: previousGoal?.threadId ?? null,
    previousStatus: previousGoal?.status ?? null,
    previousUpdatedAt: previousGoal?.updatedAt ?? null,
    incomingThreadId: goal?.threadId ?? null,
    incomingStatus: goal?.status ?? null,
    incomingUpdatedAt: goal?.updatedAt ?? null,
    acceptedStatus: acceptedGoal?.status ?? null,
    acceptedUpdatedAt: acceptedGoal?.updatedAt ?? null,
  })
  store.goalStatusReceived(address, acceptedGoal?.status ?? null)
  return acceptedGoal
}
