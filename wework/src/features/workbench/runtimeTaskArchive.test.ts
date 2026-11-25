// @vitest-environment node

import type { RuntimeTaskAddress, RuntimeTaskArchiveResponse } from '@/types/api'
import { describe, expect, it, vi } from 'vitest'
import { archiveRuntimeTaskAddresses, findFailedRuntimeTaskArchive } from './runtimeTaskArchive'

describe('archiveRuntimeTaskAddresses', () => {
  it.each([false, true])(
    'keeps the third archive outside the transport (separate single archive: %s)',
    async singleArchive => {
      const addresses = Array.from(
        { length: 3 },
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

      const resultsPromise = singleArchive
        ? Promise.all([
            archiveRuntimeTaskAddresses(addresses.slice(0, 2), archiveConversation),
            archiveRuntimeTaskAddresses(addresses.slice(2), archiveConversation),
          ]).then(results => results.flat())
        : archiveRuntimeTaskAddresses(addresses, archiveConversation)

      await expect.poll(() => archiveConversation.mock.calls.length).toBe(2)
      releases.shift()?.({
        accepted: true,
        taskId: 'runtime-0',
        runtime: 'codex',
      })
      await expect.poll(() => archiveConversation.mock.calls.length).toBe(3)
      releases.splice(0).forEach((release, index) => {
        release({
          accepted: true,
          taskId: `runtime-${index + 1}`,
          runtime: 'codex',
        })
      })

      await expect(resultsPromise).resolves.toEqual(
        addresses.map(address => ({
          address,
          response: { accepted: true, taskId: address.taskId, runtime: 'codex' },
        }))
      )
      expect(maxActive).toBe(2)
    }
  )

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
