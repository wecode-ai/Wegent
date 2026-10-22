import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTaskAddress, RuntimeTaskArchiveResponse } from '@/types/api'
import {
  archiveRuntimeTaskAddresses,
  BULK_RUNTIME_TASK_CONCURRENCY,
  findFailedRuntimeTaskArchive,
} from './runtimeTaskArchive'

describe('archiveRuntimeTaskAddresses', () => {
  it('limits bulk archive requests to the executor concurrency', async () => {
    const addresses = Array.from(
      { length: BULK_RUNTIME_TASK_CONCURRENCY + 1 },
      (_, index): RuntimeTaskAddress => ({
        deviceId: 'device-1',
        taskId: `runtime-${index}`,
      })
    )
    const releases: Array<(response: RuntimeTaskArchiveResponse) => void> = []
    let active = 0
    let maxActive = 0
    const archiveConversation = vi.fn(
      () =>
        new Promise<RuntimeTaskArchiveResponse>(resolve => {
          active += 1
          maxActive = Math.max(maxActive, active)
          releases.push(response => {
            active -= 1
            resolve(response)
          })
        })
    )

    const resultsPromise = archiveRuntimeTaskAddresses(addresses, archiveConversation)

    await expect.poll(() => archiveConversation.mock.calls.length).toBe(8)
    releases.shift()?.({
      accepted: true,
      taskId: 'runtime-0',
      runtime: 'codex',
    })
    await expect.poll(() => archiveConversation.mock.calls.length).toBe(9)
    releases.splice(0).forEach((release, index) => {
      release({
        accepted: true,
        taskId: `runtime-${index + 1}`,
        runtime: 'codex',
      })
    })

    await expect(resultsPromise).resolves.toHaveLength(9)
    expect(maxActive).toBe(BULK_RUNTIME_TASK_CONCURRENCY)
  })

  it('treats accepted archive responses as successful', () => {
    const address = { deviceId: 'device-1', taskId: 'runtime-1' }

    expect(
      findFailedRuntimeTaskArchive([
        {
          address,
          response: {
            accepted: true,
            taskId: address.taskId,
            runtime: 'codex',
          },
        },
      ])
    ).toBeUndefined()
  })

  it('returns the failed archive attempt', () => {
    const address = { deviceId: 'device-1', taskId: 'runtime-1' }
    const failedAttempt = {
      address,
      response: {
        accepted: false,
        taskId: address.taskId,
        runtime: 'codex' as const,
        error: 'archive failed',
      },
    }

    expect(findFailedRuntimeTaskArchive([failedAttempt])).toBe(failedAttempt)
  })
})
