import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'
import {
  applyWorkbenchModeToCorePlugins,
  initializeWorkbenchModePreference,
  MODE_MANAGED_DEVELOPER_HOME_PLUGIN,
  MODE_MANAGED_FOCUS_HOME_PLUGIN,
  MODE_MANAGED_GIT_PLUGIN,
  normalizeWorkbenchMode,
  probeDevelopmentCommand,
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

  test('selects and persists developer mode when a development command is available', async () => {
    const preferences = {
      read: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockImplementation(async patch => patch),
    }
    const probeCommand = vi.fn(async command => command === 'git')

    await expect(
      initializeWorkbenchModePreference(preferences, {
        environment: { PATH: '/custom/bin' },
        homeDirectory: '/home/alice',
        probeCommand,
      })
    ).resolves.toBe('developer')

    expect(preferences.update).toHaveBeenCalledWith({ workbenchMode: 'developer' })
    expect(probeCommand).toHaveBeenCalledWith(
      'git',
      expect.objectContaining({
        PATH: expect.stringContaining('/custom/bin'),
      })
    )
  })

  test('selects and persists focus mode when no development command is available', async () => {
    const preferences = {
      read: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockImplementation(async patch => patch),
    }

    await expect(
      initializeWorkbenchModePreference(preferences, {
        environment: {},
        homeDirectory: '/home/alice',
        probeCommand: vi.fn().mockResolvedValue(false),
      })
    ).resolves.toBe('focus')

    expect(preferences.update).toHaveBeenCalledWith({ workbenchMode: 'focus' })
  })

  test('checks executable files without running development commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-mode-'))
    const preferences = {
      read: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockImplementation(async patch => patch),
    }
    try {
      await writeFile(join(root, 'git.exe'), '')

      await expect(
        initializeWorkbenchModePreference(preferences, {
          environment: { PATH: root, PATHEXT: '.EXE' },
          homeDirectory: root,
          platform: 'win32',
        })
      ).resolves.toBe('developer')

      expect(preferences.update).toHaveBeenCalledWith({ workbenchMode: 'developer' })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test('uses focus mode when the executable search path is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-mode-'))
    const preferences = {
      read: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockImplementation(async patch => patch),
    }
    try {
      await expect(
        initializeWorkbenchModePreference(preferences, {
          environment: { PATH: root, PATHEXT: '.EXE' },
          homeDirectory: root,
          platform: 'win32',
        })
      ).resolves.toBe('focus')

      expect(preferences.update).toHaveBeenCalledWith({ workbenchMode: 'focus' })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test('ignores directories named like development commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-mode-'))
    try {
      await mkdir(join(root, 'git.exe'))

      await expect(
        probeDevelopmentCommand('git', { PATH: root, PATHEXT: '.EXE' }, 'win32')
      ).resolves.toBe(false)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test('ignores the macOS system Git placeholder', async () => {
    await expect(probeDevelopmentCommand('git', { PATH: '/usr/bin' }, 'darwin')).resolves.toBe(
      false
    )
  })

  test('does not treat Python alone as a development environment', async () => {
    const preferences = {
      read: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockImplementation(async patch => patch),
    }
    const probeCommand = vi.fn(async command => command === 'python3')

    await expect(
      initializeWorkbenchModePreference(preferences, {
        environment: {},
        homeDirectory: '/home/alice',
        probeCommand,
      })
    ).resolves.toBe('focus')

    expect(probeCommand).not.toHaveBeenCalledWith('python3', expect.anything())
    expect(preferences.update).toHaveBeenCalledWith({ workbenchMode: 'focus' })
  })

  test('preserves a stored mode without probing the machine again', async () => {
    const preferences = {
      read: vi.fn().mockResolvedValue({ workbenchMode: 'focus' }),
      update: vi.fn(),
    }
    const probeCommand = vi.fn()

    await expect(
      initializeWorkbenchModePreference(preferences, {
        environment: {},
        homeDirectory: '/home/alice',
        probeCommand,
      })
    ).resolves.toBe('focus')

    expect(probeCommand).not.toHaveBeenCalled()
    expect(preferences.update).not.toHaveBeenCalled()
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
