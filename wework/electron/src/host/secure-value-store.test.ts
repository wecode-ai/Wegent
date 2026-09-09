import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { SecureValueStore } from './secure-value-store.js'

describe('SecureValueStore', () => {
  test('persists AES-GCM encrypted values and its local key in private files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-secure-values-'))
    const store = new SecureValueStore(directory)

    await store.set('plugin.credential', 'secret-value')

    await expect(store.get('plugin.credential')).resolves.toBe('secret-value')
    await expect(new SecureValueStore(directory).get('plugin.credential')).resolves.toBe(
      'secret-value'
    )
    const valuesPath = join(directory, 'secure-values.json')
    const keyPath = join(directory, 'secure-values.key')
    expect(await readFile(valuesPath, 'utf8')).not.toContain('secret-value')
    expect((await readFile(keyPath)).byteLength).toBe(32)
    expect((await stat(valuesPath)).mode & 0o777).toBe(0o600)
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
    await rm(directory, { recursive: true, force: true })
  })

  test('rejects values that fail authenticated decryption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-secure-values-'))
    const store = new SecureValueStore(directory)
    await store.set('plugin.credential', 'secret-value')
    const valuesPath = join(directory, 'secure-values.json')
    const stored = JSON.parse(await readFile(valuesPath, 'utf8')) as {
      version: number
      values: Record<string, string>
    }
    const envelope = Buffer.from(stored.values['plugin.credential'] ?? '', 'base64')
    envelope[envelope.length - 1] ^= 0xff
    stored.values['plugin.credential'] = envelope.toString('base64')
    await writeFile(valuesPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 })

    await expect(new SecureValueStore(directory).get('plugin.credential')).rejects.toMatchObject({
      code: 'secure_storage_corrupted',
    })
    await rm(directory, { recursive: true, force: true })
  })
})
