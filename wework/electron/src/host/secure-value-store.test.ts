import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { SecureValueStore } from './secure-value-store.js'
import {
  MemoryCredentialBackend,
  testCredentialLock,
} from '../../test-fixtures/credential-vault.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-vault-test-'))
  directories.push(directory)
  const backend = new MemoryCredentialBackend()
  const options = { backend, acquireLock: testCredentialLock() }
  return {
    directory,
    backend,
    store: new SecureValueStore(directory, options),
    restart: () => new SecureValueStore(directory, options),
  }
}

async function legacy(directory: string, value = 'legacy-canary') {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  await writeFile(join(directory, 'secure-values.key'), key)
  await writeFile(
    join(directory, 'secure-values.json'),
    JSON.stringify({
      version: 2,
      values: {
        'plugin.credential': Buffer.concat([
          Buffer.from([1]),
          iv,
          cipher.getAuthTag(),
          bytes,
        ]).toString('base64'),
      },
    })
  )
}

describe('SecureValueStore protected generations', () => {
  test('persists in the explicit OS adapter, with no secret or master key on disk', async () => {
    const f = await fixture()
    await f.store.set('plugin.credential', 'new-canary')
    expect(await f.restart().get('plugin.credential')).toBe('new-canary')
    for (const name of await readdir(f.directory))
      expect(await readFile(join(f.directory, name), 'utf8')).not.toContain('new-canary')
    expect(await readdir(f.directory)).toEqual(['credential-profile.json'])
    await f.store.delete('plugin.credential')
    expect(await f.restart().get('plugin.credential')).toBeNull()
  })

  test('migrates and verifies every old entry before removing the old key and ciphertext', async () => {
    const f = await fixture()
    await legacy(f.directory)
    await writeFile(join(f.directory, 'secure-values.json.123.tmp'), 'old-copy')
    expect(await f.store.get('plugin.credential')).toBe('legacy-canary')
    expect(await readdir(f.directory)).toEqual(['credential-profile.json'])
    await f.store.delete('plugin.credential')
    await legacy(f.directory, 'resurrected')
    expect(await f.restart().get('plugin.credential')).toBeNull()
    expect(await readdir(f.directory)).toEqual(['credential-profile.json'])
  })

  test.each([
    'missing-key',
    'short-key',
    'unknown-version',
    'invalid-json',
    'bad-envelope',
    'bad-tag',
  ])('never rewrites or discards a damaged migration source: %s', async failure => {
    const f = await fixture()
    await legacy(f.directory)
    const file = join(f.directory, 'secure-values.json')
    if (failure === 'missing-key') await rm(join(f.directory, 'secure-values.key'))
    if (failure === 'short-key') await writeFile(join(f.directory, 'secure-values.key'), 'short')
    if (failure === 'unknown-version') await writeFile(file, '{"version":99,"values":{}}')
    if (failure === 'invalid-json') await writeFile(file, '{')
    if (failure === 'bad-envelope')
      await writeFile(file, '{"version":2,"values":{"plugin.credential":"AA=="}}')
    if (failure === 'bad-tag') {
      const stored = JSON.parse(await readFile(file, 'utf8'))
      const bytes = Buffer.from(stored.values['plugin.credential'], 'base64')
      bytes[14] ^= 255
      stored.values['plugin.credential'] = bytes.toString('base64')
      await writeFile(file, JSON.stringify(stored))
    }
    const original = await readFile(file)
    await expect(f.store.get('plugin.credential')).rejects.toMatchObject({
      code: 'secure_storage_corrupted',
    })
    expect(await readFile(file)).toEqual(original)
    if (failure === 'missing-key')
      await expect(readFile(join(f.directory, 'secure-values.key'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
  })

  test('preserves empty strings, Unicode, large values and all namespaces across chunk boundaries', async () => {
    const f = await fixture()
    const large = '凭据'.repeat(5_000)
    await f.store.update(values => {
      values['plugin.empty'] = ''
      values['plugin.large'] = large
      values['other.key'] = 'other'
    })
    expect(await f.restart().get('plugin.large')).toBe(large)
    expect(await f.store.get('plugin.empty')).toBe('')
    await f.store.delete('plugin.large')
    expect(await f.store.get('other.key')).toBe('other')
    expect([...f.backend.values.values()].every(value => Buffer.byteLength(value) < 2_560)).toBe(
      true
    )
  })

  test('serializes independent store instances under the same cross-process lock contract', async () => {
    const f = await fixture()
    await Promise.all([f.store.set('one', '1'), f.restart().set('two', '2')])
    expect(await f.store.get('one')).toBe('1')
    expect(await f.store.get('two')).toBe('2')
  })

  test('clearing one profile cannot clear another profile and cannot reimport a restored source', async () => {
    const f = await fixture()
    const other = await fixture()
    await f.store.set('one', '1')
    await other.store.set('one', 'other')
    await f.store.clear()
    await legacy(f.directory)
    expect(await f.restart().get('one')).toBeNull()
    expect(await other.store.get('one')).toBe('other')
  })

  test('rejects a copied profile when its trusted system store is absent', async () => {
    const f = await fixture()
    await f.store.set('one', '1')
    f.backend.values.clear()
    await legacy(f.directory)
    await expect(f.restart().get('one')).rejects.toMatchObject({ code: 'secure_storage_corrupted' })
    expect(await readFile(join(f.directory, 'secure-values.json'), 'utf8')).toContain('version')
  })

  test.each(['missing', 'json', 'version', 'generation', 'count', 'duplicate'])(
    'rejects corrupt trusted control without importing weak files: %s',
    async failure => {
      const f = await fixture()
      await f.store.set('stable', 'old')
      const [account, source] = [...f.backend.values].find(([key]) => key.endsWith('.control'))!
      const control = JSON.parse(source)
      if (failure === 'missing') f.backend.values.delete(account)
      else if (failure === 'json') f.backend.values.set(account, '{')
      else {
        if (failure === 'version') control.version = 99
        if (failure === 'generation') control.current.id = 'untrusted'
        if (failure === 'count') control.current.chunks = 0
        if (failure === 'duplicate') control.pending = control.current
        f.backend.values.set(account, JSON.stringify(control))
      }
      await legacy(f.directory)
      await expect(f.restart().get('stable')).rejects.toMatchObject({
        code: 'secure_storage_corrupted',
      })
      expect(await readFile(join(f.directory, 'secure-values.json'), 'utf8')).toContain('version')
    }
  )

  test.each(['missing', 'base64', 'oversized', 'json', 'version', 'values', 'key', 'type'])(
    'rejects a corrupt native chunk: %s',
    async failure => {
      const f = await fixture()
      await f.store.set('stable', 'old')
      const [account] = [...f.backend.values].find(
        ([key]) => !key.startsWith('profile.') && !key.endsWith('.control')
      )!
      const invalid: Record<string, unknown> = { version: 3, values: { stable: 'old' } }
      if (failure === 'missing') f.backend.values.delete(account)
      else if (failure === 'base64') f.backend.values.set(account, '!')
      else if (failure === 'oversized')
        f.backend.values.set(account, Buffer.alloc(1_501).toString('base64'))
      else if (failure === 'json')
        f.backend.values.set(account, Buffer.from('{').toString('base64'))
      else {
        if (failure === 'version') invalid.version = 2
        if (failure === 'values') invalid.values = []
        if (failure === 'key') invalid.values = { '../escape': 'value' }
        if (failure === 'type') invalid.values = { stable: 7 }
        f.backend.values.set(account, Buffer.from(JSON.stringify(invalid)).toString('base64'))
      }
      await expect(f.restart().get('stable')).rejects.toMatchObject({
        code: 'secure_storage_corrupted',
      })
    }
  )

  test('rejects oversized and non-string mutations before publishing any new generation', async () => {
    const f = await fixture()
    await f.store.set('stable', 'old')
    await expect(f.store.set('huge', 'x'.repeat(16 * 1024 * 1024))).rejects.toMatchObject({
      code: 'secure_storage_corrupted',
    })
    await expect(
      f.store.update(values => {
        values.invalid = 7 as never
      })
    ).rejects.toThrow()
    expect(await f.restart().get('stable')).toBe('old')
    expect(await f.store.get('huge')).toBeNull()
  })

  test('a failed native readback preserves the committed generation', async () => {
    const f = await fixture()
    await f.store.set('stable', 'old')
    f.backend.fault = stage => {
      if (
        stage.startsWith('after:set:') &&
        !stage.endsWith('.control') &&
        !stage.includes('profile.')
      ) {
        f.backend.values.set(stage.slice('after:set:'.length), 'tampered')
      }
    }
    await expect(f.store.set('stable', 'new')).rejects.toThrow()
    f.backend.fault = null
    expect(await f.restart().get('stable')).toBe('old')
  })

  test('an unreadable committed generation never deletes remaining legacy recovery files', async () => {
    const f = await fixture()
    await f.store.set('stable', 'old')
    await legacy(f.directory)
    const json = await readFile(join(f.directory, 'secure-values.json'))
    const key = await readFile(join(f.directory, 'secure-values.key'))
    const account = [...f.backend.values.keys()].find(
      name => !name.startsWith('profile.') && !name.endsWith('.control')
    )!
    f.backend.values.delete(account)
    await expect(f.restart().get('stable')).rejects.toMatchObject({
      code: 'secure_storage_corrupted',
    })
    expect(await readFile(join(f.directory, 'secure-values.json'))).toEqual(json)
    expect(await readFile(join(f.directory, 'secure-values.key'))).toEqual(key)
  })

  test('corrupt current data cannot erase the last intact retired generation during recovery', async () => {
    const f = await fixture()
    await f.store.set('stable', 'old')
    const controlAccount = [...f.backend.values.keys()].find(name => name.endsWith('.control'))!
    const old = JSON.parse(f.backend.values.get(controlAccount)!).current
    const retained = [...f.backend.values].filter(([name]) => name.includes(old.id))
    await f.store.set('stable', 'new')
    for (const [name, value] of retained) f.backend.values.set(name, value)
    const control = JSON.parse(f.backend.values.get(controlAccount)!)
    control.retired = old
    f.backend.values.set(controlAccount, JSON.stringify(control))
    const currentAccount = [...f.backend.values.keys()].find(name =>
      name.includes(control.current.id)
    )!
    f.backend.values.delete(currentAccount)
    await expect(f.restart().get('stable')).rejects.toMatchObject({
      code: 'secure_storage_corrupted',
    })
    for (const [name, value] of retained) expect(f.backend.values.get(name)).toBe(value)
  })

  test('stops native operations immediately when the cross-process lock is lost', async () => {
    const f = await fixture()
    await f.store.set('stable', 'old')
    let held = true
    let released = false
    const locked = new SecureValueStore(f.directory, {
      backend: f.backend,
      acquireLock: async () => ({
        assertHeld() {
          if (!held) throw new Error('lock lost')
        },
        async release() {
          released = true
        },
      }),
    })
    f.backend.trace.length = 0
    f.backend.fault = stage => {
      if (stage.startsWith('after:')) held = false
    }
    await expect(locked.set('stable', 'new')).rejects.toThrow('lock lost')
    expect(released).toBe(true)
    expect(f.backend.trace).toHaveLength(1)
    f.backend.fault = null
    expect(await f.restart().get('stable')).toBe('old')
  })

  test('a non-missing legacy read error is preserved instead of becoming an empty store', async () => {
    const f = await fixture()
    await mkdir(join(f.directory, 'secure-values.json'))
    await expect(f.store.initialize()).rejects.toThrow()
    expect(await readdir(f.directory)).toContain('secure-values.json')
  })

  test.each([':api_key', '../escape', '', 'x'.repeat(161), 'a b'])(
    'rejects invalid keys before any OS operation: %s',
    async key => {
      const f = await fixture()
      expect(() => f.store.get(key)).toThrow()
      expect(() => f.store.set(key, 'secret')).toThrow()
      expect(() => f.store.delete(key)).toThrow()
      expect(f.backend.trace).toEqual([])
    }
  )

  test('recovers after every read/write/delete boundary, including an applied write that reports failure', async () => {
    const baseline = await fixture()
    await baseline.store.set('stable', 'old')
    baseline.backend.trace.length = 0
    await baseline.store.set('stable', 'new')
    const count = baseline.backend.trace.length
    for (const timing of ['before', 'after'])
      for (let faultAt = 1; faultAt <= count; faultAt++) {
        const f = await fixture()
        await f.store.set('stable', 'old')
        let index = 0
        f.backend.fault = stage => {
          if (stage.startsWith(`${timing}:`) && ++index === faultAt)
            throw new Error('injected OS failure')
        }
        await expect(f.store.set('stable', 'new')).rejects.toThrow()
        f.backend.fault = null
        expect(['old', 'new']).toContain(await f.restart().get('stable'))
        await f.store.set('stable', 'final')
        expect(await f.restart().get('stable')).toBe('final')
        const controls = [...f.backend.values].filter(([key]) => key.endsWith('.control'))
        expect(controls).toHaveLength(1)
        expect(JSON.parse(controls[0][1])).toMatchObject({ pending: null, retired: null })
      }
  })

  test('initial migration is restartable before and after every native boundary', async () => {
    const baseline = await fixture()
    await legacy(baseline.directory)
    await baseline.store.initialize()
    const count = baseline.backend.trace.length
    for (const timing of ['before', 'after'])
      for (let faultAt = 1; faultAt <= count; faultAt++) {
        const f = await fixture()
        await legacy(f.directory)
        let index = 0
        f.backend.fault = stage => {
          if (stage.startsWith(`${timing}:`) && ++index === faultAt)
            throw new Error('injected migration interruption')
        }
        await expect(f.store.initialize()).rejects.toThrow()
        f.backend.fault = null
        expect(await f.restart().get('plugin.credential')).toBe('legacy-canary')
        expect(await readdir(f.directory)).toEqual(['credential-profile.json'])
      }
  })

  test('cleanup failure is visible and retryable without discarding the protected secret', async () => {
    const f = await fixture()
    await f.store.set('stable', 'old')
    const blocked = join(f.directory, 'secure-values.json.failed.tmp')
    await mkdir(blocked)
    await expect(f.store.get('stable')).rejects.toThrow()
    await rm(blocked, { recursive: true })
    expect(await f.restart().get('stable')).toBe('old')
  })
})
