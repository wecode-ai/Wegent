import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { SecureValueStore } from './secure-value-store.js'
import { createTestSecretProtection } from '../../test/secret-protection.js'

describe('SecureValueStore', () => {
  test('reads and updates protected credentials after rollback without recreating a local key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-credential-bridge-'))
    const protection = createTestSecretProtection()
    const path = join(directory, 'secure-values.json')
    try {
      await writeFile(
        path,
        JSON.stringify({
          version: 3,
          values: { original: await protection.encrypt('target-secret') },
        })
      )
      const store = new SecureValueStore(directory, protection)
      await expect(store.get('original')).resolves.toBe('target-secret')
      await store.set('__proto__', 'prototype-value')
      await expect(store.get('__proto__')).resolves.toBe('prototype-value')
      await store.delete('__proto__')
      await store.set('added', 'rollback-secret')
      await store.delete('original')
      await store.delete('added')
      await new SecureValueStore(directory, protection).set('after-clear', 'still-protected')
      await expect(new SecureValueStore(directory, protection).get('after-clear')).resolves.toBe(
        'still-protected'
      )
      const raw = await readFile(path, 'utf8')
      expect(JSON.parse(raw).version).toBe(3)
      expect(raw).not.toContain('still-protected')
      await expect(readFile(join(directory, 'secure-values.key'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails closed instead of replacing unsupported formats or a missing legacy key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-credential-bridge-'))
    try {
      const path = join(directory, 'secure-values.json')
      const store = new SecureValueStore(directory)
      for (const source of [
        JSON.stringify({ version: 4, values: { existing: 'future-ciphertext' } }),
        JSON.stringify({ version: 2, values: { existing: 'legacy-ciphertext' } }),
      ]) {
        await writeFile(path, source)
        await expect(store.set('new', 'value')).rejects.toThrow()
        expect(await readFile(path, 'utf8')).toBe(source)
        await expect(readFile(join(directory, 'secure-values.key'))).rejects.toMatchObject({
          code: 'ENOENT',
        })
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

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
    const permissions = process.platform === 'win32' ? 0o600 : 0o777
    expect((await stat(valuesPath)).mode & permissions).toBe(0o600)
    expect((await stat(keyPath)).mode & permissions).toBe(0o600)
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
