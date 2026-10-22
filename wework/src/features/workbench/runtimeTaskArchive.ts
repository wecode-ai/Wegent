import { allSettledWithConcurrency } from '@/lib/promise-concurrency'
import type { RuntimeTaskAddress, RuntimeTaskArchiveResponse } from '@/types/api'

export const BULK_RUNTIME_TASK_CONCURRENCY = 8

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

export async function archiveRuntimeTaskAddresses(
  addresses: readonly RuntimeTaskAddress[],
  archiveConversation: (address: RuntimeTaskAddress) => Promise<RuntimeTaskArchiveResponse>
): Promise<RuntimeTaskArchiveAttempt[]> {
  const results = await allSettledWithConcurrency(
    addresses,
    BULK_RUNTIME_TASK_CONCURRENCY,
    async address => ({
      address,
      response: await archiveConversation(address),
    })
  )
  return results.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : { address: addresses[index], error: result.reason }
  )
}

export function findFailedRuntimeTaskArchive(
  results: readonly RuntimeTaskArchiveAttempt[]
): RuntimeTaskArchiveAttempt | undefined {
  return results.find(result => !result.response?.accepted)
}
