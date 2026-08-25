import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { listLocalWorkspaceOpeners, saveCustomWorkspaceOpener } from './local-workspace-openers.js'

const { accessMock, execFileMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  execFileMock: vi.fn(),
}))

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}))

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  access: accessMock,
}))

describe('local workspace openers', () => {
  beforeEach(() => {
    accessMock.mockRejectedValue(new Error('Path is not installed'))
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1)
      if (typeof callback === 'function') {
        callback(new Error('Spotlight result is unavailable'), '', '')
      }
      return undefined
    })
  })

  test('always exposes the native file manager', async () => {
    await expect(listLocalWorkspaceOpeners()).resolves.toEqual(
      expect.arrayContaining([
        {
          id: 'file-manager',
          category: 'fileManager',
          available: true,
        },
      ])
    )
  })

  test.runIf(process.platform === 'darwin')('detects the macOS system Terminal', async () => {
    accessMock.mockImplementation(async (path: string) => {
      if (path === '/System/Applications/Utilities/Terminal.app') return
      throw new Error('Path is not installed')
    })

    const openers = await listLocalWorkspaceOpeners()

    expect(openers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'vscode', category: 'general' }),
        expect.objectContaining({
          id: 'terminal',
          category: 'terminal',
          available: true,
        }),
      ])
    )
    expect(openers.findIndex(opener => opener.id === 'file-manager')).toBeGreaterThan(
      openers.findIndex(opener => opener.id === 'android-studio')
    )
    expect(openers.findIndex(opener => opener.id === 'file-manager')).toBeLessThan(
      openers.findIndex(opener => opener.id === 'terminal')
    )
  })

  test('persists a custom executable atomically', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'wework-openers-'))

    await saveCustomWorkspaceOpener(dataDirectory, 'C:\\Tools\\Helix\\hx.exe')

    await expect(
      readFile(join(dataDirectory, 'local-workspace-openers.json'), 'utf8')
    ).resolves.toContain('C:\\\\Tools\\\\Helix\\\\hx.exe')
  })
})
