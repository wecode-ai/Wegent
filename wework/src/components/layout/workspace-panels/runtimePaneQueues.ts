import { RuntimeConversationQueue } from '@wegent/collaboration/execution/runtimeConversationQueue'
import type { RuntimeTaskAddress } from '@/types/api'

type Queue = RuntimeConversationQueue<number>
const queuesByWorkbench = new WeakMap<object, Map<string, Queue>>()

/** Pending replies belong to the addressed task, not the lifetime of its drawer. */
export function runtimePaneQueue(
  owner: object,
  address: RuntimeTaskAddress | null,
  instanceId: string
): Queue {
  let queues = queuesByWorkbench.get(owner)
  if (!queues) {
    queues = new Map()
    queuesByWorkbench.set(owner, queues)
  }
  const key = address ? `${address.deviceId}:${address.taskId}` : `temporary:${instanceId}`
  let queue = queues.get(key)
  if (!queue) {
    queue = new RuntimeConversationQueue()
    queues.set(key, queue)
  }
  return queue
}
