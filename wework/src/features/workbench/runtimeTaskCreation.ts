import type { RuntimeTaskAddress } from '@/types/api'
import { runtimeConversationKey } from './runtimeConversationCache'
import { abortableRuntimeRead, cancelledRuntimeRead } from './runtimeConversationReadCancellation'

const creations = new Map<string, { pending: Promise<unknown>; waitingReaders: number }>()

/** Optimistic presentation may mount readers before the owning create request persists. */
export function trackRuntimeTaskCreation<T>(
  address: RuntimeTaskAddress,
  pending: Promise<T>
): Promise<T> {
  const key = runtimeConversationKey(address)
  const entry = { pending, waitingReaders: 0 }
  creations.set(key, entry)
  const release = () => {
    if (creations.get(key) === entry) creations.delete(key)
  }
  void pending.then(release, release)
  return pending
}

export async function readAfterRuntimeTaskCreation<T>(
  address: RuntimeTaskAddress,
  read: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const entry = creations.get(runtimeConversationKey(address))
  if (entry) {
    entry.waitingReaders += 1
    try {
      await (signal ? abortableRuntimeRead(entry.pending, signal) : entry.pending)
    } finally {
      entry.waitingReaders -= 1
    }
  }
  if (signal?.aborted) throw cancelledRuntimeRead()
  return read()
}

export function getRuntimeTaskCreationDiagnostics() {
  return [...creations].map(([key, entry]) => ({ key, waitingReaders: entry.waitingReaders }))
}
