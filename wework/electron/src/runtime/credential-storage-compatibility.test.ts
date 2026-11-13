import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test, vi } from 'vitest'
import { assertCredentialStorageCompatibility } from './credential-storage-compatibility.js'
import type { ReleaseStore } from './release-store.js'

test('blocks irreversible credential migration unless the actual rollback package reads v3', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-credential-compatibility-'))
  try {
    const source = join(root, 'source')
    const target = join(root, 'target')
    for (const path of [source, target]) await mkdir(join(path, 'app.asar'), { recursive: true })
    const write = (resources: string, metadata: object) =>
      writeFile(join(resources, 'app.asar', 'package.json'), JSON.stringify(metadata))
    await write(target, { version: '0.6.8', weworkCredentialStorageVersion: 3 })
    const record = { version: '0.6.7', resources: source }
    const store = {
      activation: vi.fn().mockResolvedValue(null),
      active: vi.fn().mockResolvedValue(record),
      read: vi.fn().mockResolvedValue(record),
    } as unknown as ReleaseStore
    await write(source, { version: '0.6.7' })
    await expect(assertCredentialStorageCompatibility(store, target)).rejects.toThrow('bridge')
    await write(source, { version: '0.6.7', weworkReadableCredentialStorageVersions: [2, 3] })
    await expect(assertCredentialStorageCompatibility(store, target)).resolves.toBeUndefined()
    await write(source, { version: '0.6.6', weworkReadableCredentialStorageVersions: [2, 3] })
    await expect(assertCredentialStorageCompatibility(store, target)).rejects.toThrow('bridge')
    await write(source, { version: '0.6.7', weworkReadableCredentialStorageVersions: [2] })
    store.activation = vi.fn().mockResolvedValue({ from: 'rollback-host' })
    await expect(assertCredentialStorageCompatibility(store, target)).rejects.toThrow('bridge')
    expect(store.read).toHaveBeenCalledWith('rollback-host')
    await write(target, {
      version: '0.6.8',
      weworkCredentialStorageVersion: 3,
      weworkCredentialStorageMode: 'isolated-copy-once',
    })
    await expect(assertCredentialStorageCompatibility(store, target)).resolves.toBeUndefined()
    await write(target, { version: '0.6.7', weworkCredentialStorageVersion: 2 })
    await expect(assertCredentialStorageCompatibility(store, target)).resolves.toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
