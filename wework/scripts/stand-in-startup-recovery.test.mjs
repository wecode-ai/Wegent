// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { verifyStandInStartupRecovery } from '../e2e/desktop/modules/stand-in-startup-recovery.mjs'

const { readLog } = vi.hoisted(() => ({ readLog: vi.fn() }))
vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal()),
  readFile: readLog,
}))

test('waits for forwarded failure evidence after the task already reports failed', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'stand-in-startup-log-'))
  const retryReached = new Error('The verified startup failure can now be retried')
  let requiredSkill
  let reads = 0
  readLog.mockImplementation(async () => {
    reads += 1
    return reads === 1 ? '' : `required Skill deployment failed: ${requiredSkill}`
  })
  const rpc = vi.fn(async (method, params) => {
    if (method === 'executor.backend.status') return { connected: true }
    if (method === 'runtime.stand_in.device_identity') return { backendDeviceId: 'device' }
    if (method === 'runtime.tasks.create') {
      requiredSkill = params.executionRequest.preload_skills[0]
      return { accepted: true }
    }
    if (method === 'runtime.tasks.get')
      return { task: { status: 'failed', running: false, threadId: null, runtimeHandle: {} } }
    if (method === 'runtime.stand_in.run') throw retryReached
    throw new Error(`Unexpected RPC: ${method}`)
  })
  try {
    await expect(
      verifyStandInStartupRecovery({
        request: async () => ({ id: 'issue', title: 'Startup recovery' }),
        rpc,
        project: { id: 'project' },
        user: { id: 7 },
        settings: { roles: [{ id: 'recovery-reviewer', name: 'Reviewer' }] },
        until: async (load, ready) => {
          const value = await load()
          expect(ready(value)).toBe(true)
          return value
        },
        control: {},
        resultDir,
        timeoutMs: 1000,
      })
    ).rejects.toBe(retryReached)
    expect(readLog).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenLastCalledWith(
      'runtime.stand_in.run',
      expect.objectContaining({ issueId: 'issue', standInId: 'recovery-reviewer' })
    )
  } finally {
    await rm(resultDir, { recursive: true, force: true })
    readLog.mockReset()
  }
})
