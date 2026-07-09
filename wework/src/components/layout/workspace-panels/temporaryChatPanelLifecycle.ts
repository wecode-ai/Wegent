import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
import type { RuntimeTaskAddress } from '@/types/api'

type RuntimeTaskStreamSubscriber = WorkbenchPaneContextValue['subscribeRuntimeTaskStream']

const temporaryChatStreamSubscriptions = new Map<
  string,
  {
    addressKey: string
    subscribe: RuntimeTaskStreamSubscriber
    unsubscribe: () => void
  }
>()

export function disposeTemporaryChatPanel(instanceId: string) {
  const subscription = temporaryChatStreamSubscriptions.get(instanceId)
  subscription?.unsubscribe()
  temporaryChatStreamSubscriptions.delete(instanceId)
}

export function getTemporaryChatStreamSubscription(instanceId: string) {
  return temporaryChatStreamSubscriptions.get(instanceId)
}

export function setTemporaryChatStreamSubscription(
  instanceId: string,
  subscription: {
    addressKey: string
    subscribe: RuntimeTaskStreamSubscriber
    unsubscribe: () => void
  }
) {
  temporaryChatStreamSubscriptions.set(instanceId, subscription)
}

export function temporaryChatAddressKey(address: RuntimeTaskAddress) {
  return `${address.deviceId}:${address.taskId}`
}
