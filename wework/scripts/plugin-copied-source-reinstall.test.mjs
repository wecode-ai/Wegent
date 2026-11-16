// @vitest-environment node

import { expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  release: vi.fn(),
  hold: vi.fn(),
}))
vi.mock('../e2e/desktop/modules/plugin-write-lease.mjs', () => ({
  holdPluginWriteLease: (...args) => state.hold(...args),
}))

import { purgeUninstalledFixtureRecord } from '../e2e/desktop/modules/plugin-copied-source-reinstall.mjs'

test('historical record cleanup remains scoped and releases the coordination lease', async () => {
  state.release.mockReset()
  const executeDatabase = vi.fn().mockResolvedValue({ affected: 1 })
  const cloud = { executeDatabase }
  state.hold.mockImplementation(async actual => {
    expect(actual).toBe(cloud)
    expect(executeDatabase).not.toHaveBeenCalled()
    return { release: state.release }
  })

  await purgeUninstalledFixtureRecord(cloud, { installedId: 41, slug: 'copied-fixture' })
  const [sql, params] = executeDatabase.mock.calls[0]
  expect(sql).toContain('is_active = 0')
  expect(sql).toContain('$.spec.source.pluginKey')
  expect(params).toEqual([41, 1, 'default', 'InstalledPlugin', 'copied-fixture'])
  expect(state.release).toHaveBeenCalledTimes(1)
})

test.each([0, 2])('unexpected cleanup count %s fails and releases the lease', async affected => {
  state.release.mockReset()
  state.hold.mockResolvedValue({ release: state.release })
  const cloud = {
    executeDatabase: vi.fn().mockResolvedValue({ affected }),
  }

  await expect(
    purgeUninstalledFixtureRecord(cloud, { installedId: 41, slug: 'copied-fixture' })
  ).rejects.toThrow('Cleanup must remove exactly the inactive fixture record')
  expect(state.release).toHaveBeenCalledTimes(1)
})
