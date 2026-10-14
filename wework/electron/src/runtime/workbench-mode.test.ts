import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
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

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, access: vi.fn(actual.access), stat: vi.fn(actual.stat) }
})

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

  test('persists developer mode before an unrelated absent-command probe finishes', async () => {
    let finishAbsentProbe!: (available: boolean) => void
    const absentProbe = new Promise<boolean>(resolve => {
      finishAbsentProbe = resolve
    })
    const preferences = {
      read: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockImplementation(async patch => patch),
    }
    const initialization = initializeWorkbenchModePreference(preferences, {
      environment: {},
      homeDirectory: '/home/alice',
      probeCommand: command => (command === 'git' ? Promise.resolve(true) : absentProbe),
    })
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(preferences.update).toHaveBeenCalledWith({ workbenchMode: 'developer' })
      await expect(initialization).resolves.toBe('developer')
    } finally {
      finishAbsentProbe(false)
      await initialization
    }
  })

  test('stops remaining file searches after the first executable confirms developer mode', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let finishAbsentAccess!: () => void
    const absentAccess = new Promise<void>((_resolve, reject) => {
      finishAbsentAccess = () =>
        reject(Object.assign(new Error('Missing executable'), { code: 'ENOENT' }))
    })
    const accessMock = vi.mocked(access).mockImplementation(async path => {
      if (String(path).endsWith('git.exe')) return
      await absentAccess
    })
    const statMock = vi
      .mocked(stat)
      .mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>)
    const preferences = {
      read: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    }
    try {
      await expect(
        initializeWorkbenchModePreference(preferences, {
          environment: { PATH: 'first;second', PATHEXT: '.EXE;.CMD' },
          homeDirectory: 'home',
          platform: 'win32',
        })
      ).resolves.toBe('developer')
      const searchesAtConfirmation = accessMock.mock.calls.length
      expect(searchesAtConfirmation).toBe(13)
      finishAbsentAccess()
      await new Promise(resolve => setImmediate(resolve))
      expect(accessMock).toHaveBeenCalledTimes(searchesAtConfirmation)
      expect(statMock).toHaveBeenCalledTimes(1)
      expect(preferences.update).toHaveBeenCalledTimes(1)
    } finally {
      finishAbsentAccess()
      await new Promise(resolve => setImmediate(resolve))
      accessMock.mockReset().mockImplementation(actual.access)
      statMock.mockReset().mockImplementation(actual.stat)
    }
  })

  test('exhausts every PATH and PATHEXT candidate when no executable is available', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const accessMock = vi
      .mocked(access)
      .mockRejectedValue(Object.assign(new Error('Missing executable'), { code: 'ENOENT' }))
    const statMock = vi.mocked(stat)
    statMock.mockClear()
    const preferences = {
      read: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    }
    try {
      await expect(
        initializeWorkbenchModePreference(preferences, {
          environment: { PATH: 'first;second', PATHEXT: '.EXE;.CMD' },
          homeDirectory: 'home',
          platform: 'win32',
        })
      ).resolves.toBe('focus')
      expect(accessMock).toHaveBeenCalledTimes(52)
      expect(statMock).not.toHaveBeenCalled()
      expect(preferences.update).toHaveBeenCalledWith({ workbenchMode: 'focus' })
    } finally {
      accessMock.mockReset().mockImplementation(actual.access)
    }
  })

  test('does not stat a candidate when another search confirms the mode during access', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const search = new AbortController()
    const accessMock = vi.mocked(access).mockImplementation(async () => {
      search.abort()
    })
    const statMock = vi.mocked(stat)
    statMock.mockClear()
    try {
      await expect(
        probeDevelopmentCommand(
          'git',
          { PATH: 'first;second', PATHEXT: '.EXE;.CMD' },
          'win32',
          search.signal
        )
      ).resolves.toBe(false)
      expect(accessMock).toHaveBeenCalledTimes(1)
      expect(statMock).not.toHaveBeenCalled()
    } finally {
      accessMock.mockReset().mockImplementation(actual.access)
    }
  })

  test('does not persist focus mode until the last absent-command probe finishes', async () => {
    let finishLastProbe!: (available: boolean) => void
    const lastProbe = new Promise<boolean>(resolve => {
      finishLastProbe = resolve
    })
    const preferences = {
      read: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockImplementation(async patch => patch),
    }
    const initialization = initializeWorkbenchModePreference(preferences, {
      environment: {},
      homeDirectory: '/home/alice',
      probeCommand: command => (command === 'code' ? lastProbe : Promise.resolve(false)),
    })
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(preferences.update).not.toHaveBeenCalled()
    } finally {
      finishLastProbe(false)
    }
    await expect(initialization).resolves.toBe('focus')
    expect(preferences.update).toHaveBeenCalledWith({ workbenchMode: 'focus' })
  })

  test('propagates an unexpected probe failure before a mode has been confirmed', async () => {
    const failure = new Error('Unexpected command probe failure')
    const preferences = { read: vi.fn().mockResolvedValue({}), update: vi.fn() }
    await expect(
      initializeWorkbenchModePreference(preferences, {
        environment: {},
        homeDirectory: '/home/alice',
        probeCommand: command =>
          command === 'git' ? Promise.reject(failure) : Promise.resolve(false),
      })
    ).rejects.toBe(failure)
    expect(preferences.update).not.toHaveBeenCalled()
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
