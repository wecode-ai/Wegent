import { expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertReleasePreparationIdentity, preparationStep } from './release-preparation.js'
import type { DesktopRelease } from './release-store.js'

const release = { id: 'target', version: '1.1.0' } as DesktopRelease

test('release preparation compares the actual delivered directory through filesystem aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-preparation-identity-'))
  try {
    const resources = join(root, 'resources')
    const alias = join(root, 'selected-resources')
    const unrelated = join(root, 'other-resources')
    await mkdir(resources)
    await mkdir(unrelated)
    await symlink(resources, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const selected = { ...release, resources: alias, dataSchema: 1, readableDataSchemas: [1] }
    await expect(
      assertReleasePreparationIdentity(selected, await realpath(resources), '1.1.0', 1, [1])
    ).resolves.toBeUndefined()
    await expect(
      assertReleasePreparationIdentity(selected, unrelated, '1.1.0', 1, [1])
    ).rejects.toThrow('Target release identity does not match the selected package')
    await expect(
      assertReleasePreparationIdentity(selected, join(root, 'missing'), '1.1.0', 1, [1])
    ).rejects.toThrow('ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each([
  { version: '1.1.1', dataSchema: 1, readableDataSchemas: [1] },
  { version: '1.1.0', dataSchema: 2, readableDataSchemas: [1] },
  { version: '1.1.0', dataSchema: 1, readableDataSchemas: [1, 2] },
])('rejects package metadata mismatches before reading directories: %j', async metadata => {
  const selected = { ...release, resources: 'missing', dataSchema: 1, readableDataSchemas: [1] }
  await expect(
    assertReleasePreparationIdentity(
      selected,
      'missing',
      metadata.version,
      metadata.dataSchema,
      metadata.readableDataSchemas
    )
  ).rejects.toThrow('Target release identity does not match the selected package')
})

test('an unavailable diagnostic log does not block release preparation', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const log = { write: vi.fn().mockRejectedValue(new Error('Log directory is read-only')) }
    const prepare = vi.fn().mockResolvedValue('prepared')
    const progress = vi.fn()
    await expect(preparationStep(log, release, 'runtimes', prepare, progress)).resolves.toBe(
      'prepared'
    )
    expect(progress).toHaveBeenCalledExactlyOnceWith({
      event: 'release-preparation-stage',
      releaseId: 'target',
      version: '1.1.0',
      stage: 'runtimes',
    })
    expect(prepare).toHaveBeenCalledOnce()
    expect(log.write).toHaveBeenCalledTimes(2)
  } finally {
    diagnostic.mockRestore()
  }
})

test('a diagnostic failure preserves the actual preparation failure', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const error = new Error('Required bundled runtime is missing')
    const log = { write: vi.fn().mockRejectedValue(new Error('Log directory is read-only')) }
    await expect(
      preparationStep(log, release, 'runtimes', async () => {
        throw error
      })
    ).rejects.toBe(error)
  } finally {
    diagnostic.mockRestore()
  }
})
