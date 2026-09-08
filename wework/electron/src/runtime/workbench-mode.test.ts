import { describe, expect, test, vi } from 'vitest'
import {
  applyWorkbenchModeToCorePlugins,
  MODE_MANAGED_GIT_PLUGIN,
  normalizeWorkbenchMode,
} from './workbench-mode.js'

const gitPlugin = {
  name: MODE_MANAGED_GIT_PLUGIN,
  enabled: true,
}

describe('workbench mode runtime policy', () => {
  test('defaults unknown stored values to developer mode', () => {
    expect(normalizeWorkbenchMode('focus')).toBe('focus')
    expect(normalizeWorkbenchMode('developer')).toBe('developer')
    expect(normalizeWorkbenchMode('unknown')).toBe('developer')
    expect(normalizeWorkbenchMode(undefined)).toBe('developer')
  })

  test('disables the Git plugin in focus mode', async () => {
    const plugins = {
      list: vi.fn().mockResolvedValue([gitPlugin]),
      setEnabled: vi.fn().mockResolvedValue([]),
    }

    await applyWorkbenchModeToCorePlugins('focus', plugins)

    expect(plugins.setEnabled).toHaveBeenCalledWith(MODE_MANAGED_GIT_PLUGIN, false)
  })

  test('enables the Git plugin in developer mode', async () => {
    const plugins = {
      list: vi.fn().mockResolvedValue([{ ...gitPlugin, enabled: false }]),
      setEnabled: vi.fn().mockResolvedValue([]),
    }

    await applyWorkbenchModeToCorePlugins('developer', plugins)

    expect(plugins.setEnabled).toHaveBeenCalledWith(MODE_MANAGED_GIT_PLUGIN, true)
  })

  test('does not rewrite matching plugin state', async () => {
    const plugins = {
      list: vi.fn().mockResolvedValue([gitPlugin]),
      setEnabled: vi.fn().mockResolvedValue([]),
    }

    await applyWorkbenchModeToCorePlugins('developer', plugins)

    expect(plugins.setEnabled).not.toHaveBeenCalled()
  })

  test('allows intentionally empty UI plugin profiles', async () => {
    const plugins = {
      list: vi.fn().mockResolvedValue([]),
      setEnabled: vi.fn().mockResolvedValue([]),
    }

    await expect(applyWorkbenchModeToCorePlugins('focus', plugins)).resolves.toBeUndefined()
    expect(plugins.setEnabled).not.toHaveBeenCalled()
  })
})
