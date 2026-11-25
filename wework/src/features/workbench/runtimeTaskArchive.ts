import { DSH_BACKGROUND_CONCURRENCY } from '@/api/dsh/backgroundRequests'
import type { RuntimeTaskAddress, RuntimeTaskArchiveResponse } from '@/types/api'

export type RuntimeTaskArchiveAttempt =
  | {
      address: RuntimeTaskAddress
      response: RuntimeTaskArchiveResponse
      error?: never
    }
  | {
      address: RuntimeTaskAddress
      response?: never
      error: unknown
    }

// Share the admission limit across sidebar clicks and batch calls in this renderer.
// Waiting here keeps the DSH transport's background deadline from starting early.
const pendingArchives = new Set<() => Promise<void>>()
let activeArchives = 0

function startNextArchive() {
  if (activeArchives >= DSH_BACKGROUND_CONCURRENCY) return
  const next = pendingArchives.values().next().value
  if (!next) return

  pendingArchives.delete(next)
  activeArchives += 1
  void next().finally(() => {
    activeArchives -= 1
    startNextArchive()
  })
}

export function archiveRuntimeTaskAddresses(
  addresses: readonly RuntimeTaskAddress[],
  archiveConversation: (address: RuntimeTaskAddress) => Promise<RuntimeTaskArchiveResponse>
): Promise<RuntimeTaskArchiveAttempt[]> {
  return Promise.all(
    addresses.map(
      address =>
        new Promise<RuntimeTaskArchiveAttempt>(resolve => {
          pendingArchives.add(async () => {
            try {
              resolve({ address, response: await archiveConversation(address) })
            } catch (error) {
              resolve({ address, error })
            }
          })
          startNextArchive()
        })
    )
  )
}

export function findFailedRuntimeTaskArchive(
  results: readonly RuntimeTaskArchiveAttempt[]
): RuntimeTaskArchiveAttempt | undefined {
  return results.find(result => !result.response?.accepted)
}
