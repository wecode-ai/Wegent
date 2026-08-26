import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  installCoreDshPlugin,
  readCoreDshPlugins,
  restartCoreDsh,
  setCoreDshPluginEnabled,
  uninstallCoreDshPlugin,
  updateCoreDshPlugin,
} from './coreDshPlugins'

const invokeDesktopHost = vi.hoisted(() => vi.fn())

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost,
}))

describe('Core DSH plugin desktop API', () => {
  beforeEach(() => {
    invokeDesktopHost.mockReset()
    invokeDesktopHost.mockResolvedValue([])
  })

  test('uses explicit Electron capabilities for every operation', async () => {
    await readCoreDshPlugins()
    await installCoreDshPlugin('github:owner/plugin')
    await updateCoreDshPlugin('dsh-example')
    await setCoreDshPluginEnabled('dsh-example', false)
    await uninstallCoreDshPlugin('dsh-example')
    await restartCoreDsh()

    expect(invokeDesktopHost.mock.calls).toEqual([
      ['runtime.listCoreDshPlugins'],
      ['runtime.installCoreDshPlugin', { spec: 'github:owner/plugin' }],
      ['runtime.updateCoreDshPlugin', { name: 'dsh-example' }],
      ['runtime.setCoreDshPluginEnabled', { name: 'dsh-example', enabled: false }],
      ['runtime.uninstallCoreDshPlugin', { name: 'dsh-example' }],
      ['runtime.restartCoreDsh'],
    ])
  })
})
