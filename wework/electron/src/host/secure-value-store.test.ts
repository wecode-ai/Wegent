import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import { SecureValueStore } from './secure-value-store.js'
import { createTestSecretProtection } from '../../test/secret-protection.js'
import { protectedCredentialDirectory } from './credential-storage-paths.js'

const protection = createTestSecretProtection()

async function legacyFixture(directory: string) {
  const key = randomBytes(32)
  const values: Record<string, string> = {}
  for (const [name, value] of Object.entries({ first: 'legacy-one', second: 'legacy-two' })) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()])
    values[name] = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]).toString(
      'base64'
    )
  }
  const source = JSON.stringify({ version: 2, values })
  await writeFile(join(directory, 'secure-values.json'), source)
  await writeFile(join(directory, 'secure-values.key'), key)
  return { source, key }
}

describe('SecureValueStore', () => {
  test('rotates one native ciphertext atomically without changing unrelated values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-key-rotation-'))
    try {
      const old = new SecureValueStore(directory, protection)
      await old.set('first', 'first-secret')
      await old.set('second', 'second-secret')
      const path = join(protectedCredentialDirectory(directory), 'secure-values.json')
      const before = JSON.parse(await readFile(path, 'utf8'))
      const next = createTestSecretProtection()
      const rotating = new SecureValueStore(directory, {
        encrypt: next.encrypt,
        decrypt: async value => ({ ...(await protection.decrypt(value)), shouldReEncrypt: true }),
      })
      await expect(rotating.get('first')).resolves.toBe('first-secret')
      const after = JSON.parse(await readFile(path, 'utf8'))
      expect(after.values.second).toBe(before.values.second)
      expect(after.values.first).not.toBe(before.values.first)
      await expect(new SecureValueStore(directory, next).get('first')).resolves.toBe('first-secret')
      await expect(protection.decrypt(after.values.first)).rejects.toThrow()
      const failing = new SecureValueStore(directory, {
        decrypt: async value => ({ ...(await protection.decrypt(value)), shouldReEncrypt: true }),
        encrypt: async () => {
          throw new Error('Rotation unavailable')
        },
      })
      await expect(failing.get('second')).rejects.toThrow('Rotation unavailable')
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(after)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  test('persists a new prototype-named key when reopening an existing store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-secure-values-'))
    try {
      await new SecureValueStore(directory, protection).set('existing', 'preserved')
      const reopened = new SecureValueStore(directory, protection)
      await reopened.set('__proto__', 'prototype-value')
      await expect(new SecureValueStore(directory, protection).get('__proto__')).resolves.toBe(
        'prototype-value'
      )
      await expect(reopened.get('existing')).resolves.toBe('preserved')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('keeps an empty protected store so later reads cannot reimport legacy values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-secure-values-'))
    try {
      const store = new SecureValueStore(directory, protection)
      await store.set('last', 'secret')
      await store.delete('last')
      expect(
        JSON.parse(
          await readFile(
            join(protectedCredentialDirectory(directory), 'secure-values.json'),
            'utf8'
          )
        )
      ).toEqual({
        version: 3,
        values: {},
      })
      await new SecureValueStore(directory, protection).set('next', 'next-secret')
      await expect(readFile(join(directory, 'secure-values.key'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('imports every legacy value once while preserving the rollback files unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-secure-values-'))
    try {
      const legacy = await legacyFixture(directory)
      const store = new SecureValueStore(directory, protection)
      await expect(store.get('first')).resolves.toBe('legacy-one')
      await expect(store.get('second')).resolves.toBe('legacy-two')
      const source = await readFile(
        join(protectedCredentialDirectory(directory), 'secure-values.json'),
        'utf8'
      )
      expect(JSON.parse(source).version).toBe(3)
      expect(source).not.toContain('legacy-one')
      expect(await readFile(join(directory, 'secure-values.key'))).toEqual(legacy.key)
      expect(await readFile(join(directory, 'secure-values.json'), 'utf8')).toBe(legacy.source)
      await store.set('first', 'new-store-value')
      await writeFile(join(directory, 'secure-values.json'), 'unreadable legacy data')
      await rm(join(directory, 'secure-values.key'))
      const reopened = new SecureValueStore(directory, protection)
      await expect(reopened.get('first')).resolves.toBe('new-store-value')
      await expect(reopened.get('second')).resolves.toBe('legacy-two')
      await reopened.delete('first')
      await expect(new SecureValueStore(directory, protection).get('first')).resolves.toBeNull()
      await expect(
        new SecureValueStore(directory, createTestSecretProtection()).get('second')
      ).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('preserves legacy ciphertext and key if migration cannot protect all values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-secure-values-'))
    try {
      const { source, key } = await legacyFixture(directory)
      let calls = 0
      const store = new SecureValueStore(directory, {
        ...protection,
        encrypt: async value => {
          if (++calls === 2) throw new Error('OS credential service unavailable')
          return protection.encrypt(value)
        },
      })
      await expect(store.get('first')).rejects.toThrow('OS credential service unavailable')
      expect(await readFile(join(directory, 'secure-values.json'), 'utf8')).toBe(source)
      expect(await readFile(join(directory, 'secure-values.key'))).toEqual(key)
      await expect(new SecureValueStore(directory, protection).get('second')).resolves.toBe(
        'legacy-two'
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails closed on a missing legacy key without discarding existing values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-secure-values-'))
    try {
      const { source } = await legacyFixture(directory)
      await rm(join(directory, 'secure-values.key'))
      await expect(
        new SecureValueStore(directory, protection).set('new', 'value')
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(directory, 'secure-values.json'), 'utf8')).toBe(source)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('never falls back to legacy data after the protected store exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-secure-values-'))
    try {
      const legacy = await legacyFixture(directory)
      const store = new SecureValueStore(directory, protection)
      await store.get('first')
      await store.delete('first')
      await store.delete('second')
      await expect(new SecureValueStore(directory, protection).get('first')).resolves.toBeNull()
      await writeFile(
        join(protectedCredentialDirectory(directory), 'secure-values.json'),
        legacy.source
      )
      await expect(new SecureValueStore(directory, protection).get('first')).rejects.toMatchObject({
        code: 'secure_storage_corrupted',
      })
      expect(await readFile(join(directory, 'secure-values.json'), 'utf8')).toBe(legacy.source)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('persists encrypted values without a recoverable local key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-secure-values-'))
    const store = new SecureValueStore(directory, protection)

    await expect(store.get('constructor')).resolves.toBeNull()
    await store.set('__proto__', 'prototype-key-value')
    await expect(store.get('__proto__')).resolves.toBe('prototype-key-value')
    await store.set('plugin.credential', 'secret-value')
    await store.set('constructor', 'constructor-value')
    await expect(new SecureValueStore(directory, protection).get('constructor')).resolves.toBe(
      'constructor-value'
    )

    await expect(store.get('plugin.credential')).resolves.toBe('secret-value')
    await expect(
      new SecureValueStore(directory, protection).get('plugin.credential')
    ).resolves.toBe('secret-value')
    const valuesPath = join(protectedCredentialDirectory(directory), 'secure-values.json')
    const keyPath = join(directory, 'secure-values.key')
    expect(await readFile(valuesPath, 'utf8')).not.toContain('secret-value')
    await expect(readFile(keyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const permissions = process.platform === 'win32' ? 0o600 : 0o777
    expect((await stat(valuesPath)).mode & permissions).toBe(0o600)
    await rm(directory, { recursive: true, force: true })
  })

  test('rejects values that fail authenticated decryption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-secure-values-'))
    const store = new SecureValueStore(directory, protection)
    await store.set('plugin.credential', 'secret-value')
    const valuesPath = join(protectedCredentialDirectory(directory), 'secure-values.json')
    const stored = JSON.parse(await readFile(valuesPath, 'utf8')) as {
      version: number
      values: Record<string, string>
    }
    const envelope = Buffer.from(stored.values['plugin.credential'] ?? '', 'base64')
    envelope[envelope.length - 1] ^= 0xff
    stored.values['plugin.credential'] = envelope.toString('base64')
    await writeFile(valuesPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 })

    await expect(
      new SecureValueStore(directory, protection).get('plugin.credential')
    ).rejects.toThrow()
    await rm(directory, { recursive: true, force: true })
  })
})
