import { describe, expect, test, vi } from 'vitest'
import {
  applyWorkbenchModeToCorePlugins,
  MODE_MANAGED_DEVELOPER_HOME_PLUGIN,
  MODE_MANAGED_FOCUS_HOME_PLUGIN,
  MODE_MANAGED_GIT_PLUGIN,
  normalizeWorkbenchMode,
} from './workbench-mode.js'

const gitPlugin = {
  name: MODE_MANAGED_GIT_PLUGIN,
  enabled: true,
}

const focusHomePlugin = {
  name: MODE_MANAGED_FOCUS_HOME_PLUGIN,
  enabled: false,
}

const developerHomePlugin = {
  name: MODE_MANAGED_DEVELOPER_HOME_PLUGIN,
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
      list: vi.fn().mockResolvedValue([gitPlugin, focusHomePlugin, developerHomePlugin]),
      setEnabled: vi.fn().mockResolvedValue([]),
    }

    await applyWorkbenchModeToCorePlugins('focus', plugins)

    expect(plugins.setEnabled.mock.calls).toEqual([
      [MODE_MANAGED_GIT_PLUGIN, false],
      [MODE_MANAGED_FOCUS_HOME_PLUGIN, true],
      [MODE_MANAGED_DEVELOPER_HOME_PLUGIN, false],
    ])
  })

  test('enables the Git plugin in developer mode', async () => {
    const plugins = {
      list: vi.fn().mockResolvedValue([
        { ...gitPlugin, enabled: false },
        { ...focusHomePlugin, enabled: true },
        { ...developerHomePlugin, enabled: false },
      ]),
      setEnabled: vi.fn().mockResolvedValue([]),
    }

    await applyWorkbenchModeToCorePlugins('developer', plugins)

    expect(plugins.setEnabled.mock.calls).toEqual([
      [MODE_MANAGED_GIT_PLUGIN, true],
      [MODE_MANAGED_FOCUS_HOME_PLUGIN, false],
      [MODE_MANAGED_DEVELOPER_HOME_PLUGIN, true],
    ])
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
