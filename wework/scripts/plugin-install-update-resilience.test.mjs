// @vitest-environment node

import { beforeEach, expect, test, vi } from 'vitest'

vi.mock('../e2e/desktop/modules/plugin-write-lease.mjs', () => ({
  holdPluginWriteLease: vi.fn(),
}))

import { settlePluginPolicyWrite } from '../e2e/desktop/modules/plugin-install-update-resilience.mjs'
import { holdPluginWriteLease } from '../e2e/desktop/modules/plugin-write-lease.mjs'

beforeEach(() => vi.resetAllMocks())

const row = (device_id, last_sync_at, state = 'installed') => ({
  device_id,
  last_sync_at,
  state,
})

test('waits for every Runtime policy ACK and the scoped writer before continuing', async () => {
  const before = [row('app', 'old'), row('cloud', 'old')]
  const complete = [row('app', 'new'), row('cloud', 'new')]
  const queries = [before, before, [row('app', 'new'), row('cloud', 'old')], complete]
  const cloud = {
    queryDatabase: vi.fn(async (_sql, params) => {
      expect(params).toEqual([1, 95])
      expect(holdPluginWriteLease).not.toHaveBeenCalled()
      return queries.shift()
    }),
  }
  let releaseWriter
  const release = vi.fn(() => new Promise(resolve => (releaseWriter = resolve)))
  holdPluginWriteLease.mockImplementation(async () => {
    expect(queries).toHaveLength(0)
    return { release }
  })
  const operate = vi.fn(async () => {
    expect(cloud.queryDatabase).toHaveBeenCalledTimes(1)
  })
  let finished = false
  const pending = settlePluginPolicyWrite(cloud, 95, operate, 1000).then(result => {
    finished = true
    return result
  })
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
  expect(finished).toBe(false)
  releaseWriter()
  await expect(pending).resolves.toEqual(complete)
  expect(operate).toHaveBeenCalledOnce()
  expect(holdPluginWriteLease).toHaveBeenCalledWith(cloud, 95)
})

test('does not admit auto-update after a fresh but failed policy sync', async () => {
  const cloud = {
    queryDatabase: vi
      .fn()
      .mockResolvedValueOnce([row('app', 'old')])
      .mockResolvedValue([row('app', 'new', 'failed')]),
  }
  await expect(settlePluginPolicyWrite(cloud, 95, vi.fn(), 1)).rejects.toThrow(
    'Plugin policy sync did not persist on every existing Runtime'
  )
  expect(holdPluginWriteLease).not.toHaveBeenCalled()
})

test('rejects missing device setup before changing the policy', async () => {
  const cloud = { queryDatabase: vi.fn().mockResolvedValue([]) }
  const operate = vi.fn()
  await expect(settlePluginPolicyWrite(cloud, 95, operate, 1000)).rejects.toThrow(
    'Policy setup needs existing real device installations'
  )
  expect(operate).not.toHaveBeenCalled()
  expect(holdPluginWriteLease).not.toHaveBeenCalled()
})
