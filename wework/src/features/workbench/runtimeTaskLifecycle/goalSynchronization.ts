import type { RuntimeGoal, RuntimeTaskAddress } from '@/types/api'
import { setRuntimeConversationGoal } from '../runtimeConversationCache'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

export function syncRuntimeGoal(
  store: RuntimeTaskLifecycleStore,
  address: RuntimeTaskAddress,
  goal: RuntimeGoal | null
): RuntimeGoal | null {
  const acceptedGoal = setRuntimeConversationGoal(address, goal)
  store.goalStatusReceived(address, acceptedGoal?.status ?? null)
  return acceptedGoal
}
