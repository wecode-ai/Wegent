import { describe, expect, test, vi } from 'vitest'
import { ensureDirectory } from './ensure-directory.js'

describe('ensureDirectory', () => {
  test('reuses an existing Windows drive root without calling mkdir', async () => {
    const fileSystem = {
      stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
      mkdir: vi.fn(),
    }

    await ensureDirectory('D:\\', fileSystem)

    expect(fileSystem.stat).toHaveBeenCalledWith('D:\\')
    expect(fileSystem.mkdir).not.toHaveBeenCalled()
  })

  test('creates a missing directory recursively', async () => {
    const fileSystem = {
      stat: vi.fn().mockRejectedValue(errorWithCode('ENOENT')),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }

    await ensureDirectory('/missing/downloads', fileSystem)

    expect(fileSystem.mkdir).toHaveBeenCalledWith('/missing/downloads', { recursive: true })
  })

  test('rejects a path that already exists as a file', async () => {
    const fileSystem = {
      stat: vi.fn().mockResolvedValue({ isDirectory: () => false }),
      mkdir: vi.fn(),
    }

    await expect(ensureDirectory('/downloads', fileSystem)).rejects.toThrow(
      'Expected a directory at /downloads'
    )
    expect(fileSystem.mkdir).not.toHaveBeenCalled()
  })

  test('preserves stat errors other than a missing path', async () => {
    const error = errorWithCode('EACCES')
    const fileSystem = {
      stat: vi.fn().mockRejectedValue(error),
      mkdir: vi.fn(),
    }

    await expect(ensureDirectory('/downloads', fileSystem)).rejects.toBe(error)
    expect(fileSystem.mkdir).not.toHaveBeenCalled()
  })
})

function errorWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}
