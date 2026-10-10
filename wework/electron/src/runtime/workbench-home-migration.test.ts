import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { temporaryDirectory } from './test-helpers.js'
import {
  migrateWorkbenchHome,
  type WorkbenchHomeMigrationOptions,
} from './workbench-home-migration.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    symlink: vi.fn(actual.symlink),
    readFile: vi.fn(actual.readFile),
  }
})

const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const interrupted = new Error('simulated process interruption')
let directory: Awaited<ReturnType<typeof temporaryDirectory>>
let options: WorkbenchHomeMigrationOptions
const heldResources = new Set<string>()

beforeEach(async () => {
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
  vi.mocked(fs.symlink).mockReset().mockImplementation(actual.symlink)
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile)
  directory = await temporaryDirectory('workbench-home-migration-')
  const root = await fs.realpath(directory.path)
  options = {
    acquireLock: async resources => {
      if (resources.some(path => heldResources.has(path))) throw new Error('lock unavailable')
      for (const path of resources) heldResources.add(path)
      return {
        assertHeld() {
          if (resources.some(path => !heldResources.has(path))) throw new Error('lock lost')
        },
        async release() {
          for (const path of resources) heldResources.delete(path)
        },
      }
    },
    sourceHome: join(root, 'legacy', 'codex'),
    targetHome: join(root, 'workbench', 'codex'),
    stateDirectory: join(root, 'state'),
  }
  heldResources.clear()
})

afterEach(async () => {
  await directory.remove()
})

async function createSource(): Promise<void> {
  await fs.mkdir(options.sourceHome, { recursive: true, mode: 0o700 })
  await fs.mkdir(join(options.sourceHome, 'skills'))
  await fs.writeFile(join(options.sourceHome, 'auth.json'), 'synthetic-auth', { mode: 0o600 })
  await fs.writeFile(join(options.sourceHome, 'state.sqlite'), 'synthetic-sqlite', { mode: 0o600 })
  await fs.writeFile(join(options.sourceHome, 'state.sqlite-wal'), 'synthetic-wal')
  await fs.writeFile(join(options.sourceHome, 'session.jsonl'), options.sourceHome)
  await fs.symlink('../state.sqlite', join(options.sourceHome, 'skills', 'internal'))
  await fs.symlink(
    join(options.sourceHome, 'skills'),
    join(directory.path, 'saved-skill-link'),
    'dir'
  )
}

async function assertBridge(): Promise<void> {
  expect((await fs.lstat(options.sourceHome)).isSymbolicLink()).toBe(true)
  expect(await fs.readlink(options.sourceHome)).toBe(options.targetHome)
  expect(await fs.realpath(join(directory.path, 'saved-skill-link'))).toBe(
    join(options.targetHome, 'skills')
  )
  expect(await fs.readFile(join(options.sourceHome, 'session.jsonl'), 'utf8')).toBe(
    options.sourceHome
  )
}

async function interruptBeforeMove(): Promise<void> {
  vi.mocked(fs.rename).mockRejectedValueOnce(interrupted)
  await expect(migrateWorkbenchHome(options)).rejects.toBe(interrupted)
}

describe('migrateWorkbenchHome', () => {
  test('converts a previously published reverse bridge into a physical migration', async () => {
    await createSource()
    const before = await fs.lstat(options.sourceHome)
    await migrateWorkbenchHome({ ...options, preserveExistingSource: true })
    const beforeMove = vi.fn(async () => {
      expect(heldResources.has(options.sourceHome)).toBe(true)
    })
    await expect(migrateWorkbenchHome({ ...options, beforeMove })).resolves.toBe('migrated')
    expect(beforeMove).toHaveBeenCalledOnce()
    expect((await fs.lstat(options.targetHome)).ino).toBe(before.ino)
    await assertBridge()
    await expect(migrateWorkbenchHome({ ...options, beforeMove })).resolves.toBe('already-migrated')
    expect(beforeMove).toHaveBeenCalledOnce()
  })

  test.each(['journal', 'move', 'bridge'])(
    'recovers interrupted preserve-source conversion at %s publication',
    async stage => {
      await createSource()
      await migrateWorkbenchHome({ ...options, preserveExistingSource: true })
      vi.mocked(fs.rename).mockImplementation(async (source, target) => {
        if (
          (stage === 'journal' && String(target).endsWith('workbench-home-migration.json')) ||
          (stage === 'move' && source === options.sourceHome) ||
          (stage === 'bridge' && target === options.sourceHome)
        )
          throw interrupted
        return actual.rename(source, target)
      })
      await expect(migrateWorkbenchHome(options)).rejects.toBe(interrupted)
      vi.mocked(fs.rename).mockImplementation(actual.rename)
      await migrateWorkbenchHome(options)
      await assertBridge()
      await expect(migrateWorkbenchHome(options)).resolves.toBe('already-migrated')
    }
  )

  test('rejects conversion if the new entry was replaced or credential preflight fails', async () => {
    await createSource()
    await migrateWorkbenchHome({ ...options, preserveExistingSource: true })
    const journalPath = join(options.stateDirectory, 'workbench-home-migration.json')
    const journal = await fs.readFile(journalPath, 'utf8')
    await expect(
      migrateWorkbenchHome({
        ...options,
        beforeMove: async () => {
          throw new Error('keyring')
        },
      })
    ).rejects.toThrow('keyring')
    expect(await fs.readFile(journalPath, 'utf8')).toBe(journal)
    expect(await fs.readlink(options.targetHome)).toBe(options.sourceHome)
    await fs.unlink(options.targetHome)
    await fs.mkdir(options.targetHome)
    await expect(migrateWorkbenchHome(options)).rejects.toThrow('target conflict')
    expect(await fs.readFile(journalPath, 'utf8')).toBe(journal)
    expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
  })

  test('preserves existing canonical Home and native credential key while exposing the new entry', async () => {
    await createSource()
    const nativeKeys = async (home: string) => {
      const digest = createHash('sha256')
        .update(await fs.realpath(home))
        .digest('hex')
        .slice(0, 16)
      return { auth: `cli|${digest}`, secrets: `secrets|${digest}` }
    }
    const before = await fs.lstat(options.sourceHome)
    const keys = await nativeKeys(options.sourceHome)
    await fs.symlink('../../unresolved-external', join(options.sourceHome, 'skills', 'untouched'))
    vi.mocked(fs.readFile).mockClear()
    await expect(migrateWorkbenchHome({ ...options, preserveExistingSource: true })).resolves.toBe(
      'migrated'
    )
    expect(fs.readFile).not.toHaveBeenCalled()
    expect((await fs.lstat(options.sourceHome)).ino).toBe(before.ino)
    expect(await fs.readlink(options.targetHome)).toBe(options.sourceHome)
    expect(await nativeKeys(options.targetHome)).toEqual(keys)
    expect(await fs.readlink(join(options.sourceHome, 'skills', 'untouched'))).toBe(
      '../../unresolved-external'
    )
    await fs.writeFile(join(options.targetHome, 'post-upgrade'), 'new data')
    expect(await fs.readFile(join(options.sourceHome, 'post-upgrade'), 'utf8')).toBe('new data')
    await expect(migrateWorkbenchHome({ ...options, preserveExistingSource: true })).resolves.toBe(
      'already-migrated'
    )
  })

  test('recovers an interrupted new entry publication without relocating the backing Home', async () => {
    await createSource()
    await expect(
      (async () => {
        vi.mocked(fs.rename).mockRejectedValueOnce(interrupted)
        return migrateWorkbenchHome({ ...options, preserveExistingSource: true })
      })()
    ).rejects.toBe(interrupted)
    expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
    await expect(migrateWorkbenchHome({ ...options, preserveExistingSource: true })).resolves.toBe(
      'migrated'
    )
    expect(await fs.realpath(options.targetHome)).toBe(options.sourceHome)
  })

  test('refuses a replaced backing Home after publishing the new entry', async () => {
    await createSource()
    const preserving = { ...options, preserveExistingSource: true }
    await migrateWorkbenchHome(preserving)
    await actual.rename(options.sourceHome, join(directory.path, 'original-home'))
    await fs.mkdir(options.sourceHome)
    await expect(migrateWorkbenchHome(preserving)).rejects.toThrow(/source identity changed/)
  })

  test('preserve-source mode refuses an unknown target instead of making a link cycle', async () => {
    await createSource()
    await fs.mkdir(join(options.targetHome, '..'), { recursive: true })
    await fs.symlink(options.sourceHome, options.targetHome, 'dir')
    await expect(
      migrateWorkbenchHome({ ...options, preserveExistingSource: true })
    ).rejects.toThrow(/conflict/)
    expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
  })

  test('new installations use new backing Home even when existing Homes would be preserved', async () => {
    await migrateWorkbenchHome({ ...options, initialize: true, preserveExistingSource: true })
    expect((await fs.lstat(options.targetHome)).isDirectory()).toBe(true)
    expect(await fs.readlink(options.sourceHome)).toBe(options.targetHome)
  })

  test('returns no-source on first installation without creating a Home or journal', async () => {
    await expect(migrateWorkbenchHome(options)).resolves.toBe('no-source')
    await expect(fs.lstat(options.sourceHome)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(options.targetHome)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(options.stateDirectory)).toEqual([])
  })

  test('accepts an existing new-installation directory when no source or journal exists', async () => {
    await fs.mkdir(options.targetHome, { recursive: true })
    await fs.writeFile(join(options.targetHome, 'new-installation'), 'keep')
    await expect(migrateWorkbenchHome(options)).resolves.toBe('no-source')
    expect(await fs.readFile(join(options.targetHome, 'new-installation'), 'utf8')).toBe('keep')
    expect(await fs.readdir(options.stateDirectory)).toEqual([])
  })

  test('initializes new Homes with the same downgrade bridge and recoverable journal', async () => {
    await expect(migrateWorkbenchHome({ ...options, initialize: true })).resolves.toBe('migrated')
    await fs.writeFile(join(options.targetHome, 'new-session'), 'new data')
    expect(await fs.readFile(join(options.sourceHome, 'new-session'), 'utf8')).toBe('new data')
    await expect(migrateWorkbenchHome({ ...options, initialize: true })).resolves.toBe(
      'already-migrated'
    )
  })

  test('initialization never adopts a target without an ownership journal', async () => {
    await fs.mkdir(options.targetHome, { recursive: true })
    await expect(migrateWorkbenchHome({ ...options, initialize: true })).rejects.toThrow(/conflict/)
    await expect(fs.lstat(options.sourceHome)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('moves inodes and permissions intact without reading Home files', async () => {
    await createSource()
    const names = ['', 'auth.json', 'state.sqlite', 'state.sqlite-wal', 'session.jsonl']
    const before = await Promise.all(names.map(name => fs.lstat(join(options.sourceHome, name))))
    vi.mocked(fs.readFile).mockClear()

    await expect(migrateWorkbenchHome(options)).resolves.toBe('migrated')

    expect(fs.readFile).not.toHaveBeenCalled()
    const after = await Promise.all(names.map(name => fs.lstat(join(options.targetHome, name))))
    expect(after.map(({ dev, ino, mode }) => ({ dev, ino, mode }))).toEqual(
      before.map(({ dev, ino, mode }) => ({ dev, ino, mode }))
    )
    expect(await fs.readlink(join(options.targetHome, 'skills', 'internal'))).toBe(
      '../state.sqlite'
    )
    await assertBridge()
  })

  test('recognizes its completed bridge on repeated invocation', async () => {
    await createSource()
    await migrateWorkbenchHome(options)
    vi.mocked(fs.rename).mockClear()
    await expect(migrateWorkbenchHome(options)).resolves.toBe('already-migrated')
    expect(fs.rename).not.toHaveBeenCalled()
    await assertBridge()
  })

  test.each(['unchanged', 'replaced-directory', 'redirected-link'])(
    'checks completed directory identity after a remount: %s',
    async change => {
      await createSource()
      await migrateWorkbenchHome(options)
      const journalPath = join(options.stateDirectory, 'workbench-home-migration.json')
      const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
      journal.device = (BigInt(journal.device) + 1n).toString()
      const contents = JSON.stringify(journal)
      await fs.writeFile(journalPath, contents)
      if (change === 'replaced-directory') {
        await fs.rename(options.targetHome, `${options.targetHome}-original`)
        await fs.mkdir(options.targetHome)
      } else if (change === 'redirected-link') {
        await fs.unlink(options.sourceHome)
        await fs.symlink(directory.path, options.sourceHome, 'dir')
      }
      vi.mocked(fs.rename).mockClear()
      if (change === 'unchanged') {
        await expect(migrateWorkbenchHome(options)).resolves.toBe('already-migrated')
        await assertBridge()
      } else {
        await expect(migrateWorkbenchHome(options)).rejects.toThrow('source symlink conflict')
      }
      expect(fs.rename).not.toHaveBeenCalled()
      expect(await fs.readFile(journalPath, 'utf8')).toBe(contents)
    }
  )

  test('still rejects a changed device before an interrupted move completes', async () => {
    await createSource()
    await interruptBeforeMove()
    vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
    const journalPath = join(options.stateDirectory, 'workbench-home-migration.json')
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
    journal.device = (BigInt(journal.device) + 1n).toString()
    await fs.writeFile(journalPath, JSON.stringify(journal))
    await expect(migrateWorkbenchHome(options)).rejects.toThrow('source identity changed')
    expect(fs.rename).not.toHaveBeenCalled()
  })

  test('resumes after journal publication before the Home rename', async () => {
    await createSource()
    await interruptBeforeMove()
    expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
    await expect(migrateWorkbenchHome(options)).resolves.toBe('migrated')
    await assertBridge()
  })

  test('recovers a crash immediately after Home rename and before bridge publication', async () => {
    await createSource()
    vi.mocked(fs.rename).mockImplementationOnce(async (source, target) => {
      await actual.rename(source, target)
      throw interrupted
    })
    await expect(migrateWorkbenchHome(options)).rejects.toBe(interrupted)
    await expect(fs.lstat(options.sourceHome)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(migrateWorkbenchHome(options)).resolves.toBe('migrated')
    await assertBridge()
  })

  test('reuses the journal-owned temporary symlink after an interruption', async () => {
    await createSource()
    vi.mocked(fs.symlink).mockImplementationOnce(async (target, path, type) => {
      await actual.symlink(target, path, type)
      throw interrupted
    })
    await expect(migrateWorkbenchHome(options)).rejects.toBe(interrupted)
    expect(
      (await fs.readdir(join(options.sourceHome, '..'))).some(name => name.endsWith('.tmp'))
    ).toBe(true)
    await expect(migrateWorkbenchHome(options)).resolves.toBe('migrated')
    expect(await fs.readdir(join(options.sourceHome, '..'))).toEqual(['codex'])
    await assertBridge()
  })

  test('checks symlink privileges before moving the Home', async () => {
    await createSource()
    vi.mocked(fs.symlink).mockRejectedValueOnce(
      Object.assign(new Error('symlink privilege unavailable'), { code: 'EPERM' })
    )
    await expect(migrateWorkbenchHome(options)).rejects.toMatchObject({ code: 'EPERM' })
    expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
    await expect(fs.lstat(options.targetHome)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fs.rename).not.toHaveBeenCalled()
    await expect(migrateWorkbenchHome(options)).resolves.toBe('migrated')
    await assertBridge()
  })

  test('does not overwrite an unknown temporary bridge', async () => {
    await createSource()
    await interruptBeforeMove()
    const journal = JSON.parse(
      await fs.readFile(join(options.stateDirectory, 'workbench-home-migration.json'), 'utf8')
    ) as { token: string }
    const temporary = `${options.sourceHome}.migration-${journal.token}.tmp`
    await fs.unlink(temporary)
    await fs.writeFile(temporary, 'unknown file')
    await expect(migrateWorkbenchHome(options)).rejects.toThrow(/temporary link conflict/)
    expect(await fs.readFile(temporary, 'utf8')).toBe('unknown file')
    expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
  })

  test('recognizes completion even if bridge publication returned an interruption', async () => {
    await createSource()
    vi.mocked(fs.rename)
      .mockImplementationOnce(actual.rename)
      .mockImplementationOnce(async (source, target) => {
        await actual.rename(source, target)
        throw interrupted
      })
    await expect(migrateWorkbenchHome(options)).rejects.toBe(interrupted)
    await expect(migrateWorkbenchHome(options)).resolves.toBe('already-migrated')
    await assertBridge()
  })

  test.each(['empty-directory', 'populated-directory', 'file', 'dangling-symlink'])(
    'refuses an unknown target: %s',
    async kind => {
      await createSource()
      await fs.mkdir(join(options.targetHome, '..'), { recursive: true })
      if (kind.endsWith('directory')) {
        await fs.mkdir(options.targetHome)
        if (kind === 'populated-directory')
          await fs.writeFile(join(options.targetHome, 'keep'), 'keep')
      } else if (kind === 'file') {
        await fs.writeFile(options.targetHome, 'keep')
      } else {
        await fs.symlink(join(directory.path, 'missing'), options.targetHome, 'dir')
      }
      const before = await fs.lstat(options.targetHome)
      await expect(migrateWorkbenchHome(options)).rejects.toThrow(/conflict/)
      expect((await fs.lstat(options.targetHome)).ino).toBe(before.ino)
      expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
      expect(fs.rename).not.toHaveBeenCalled()
    }
  )

  test('does not adopt an unknown target during recovery', async () => {
    await createSource()
    await interruptBeforeMove()
    await actual.rename(options.sourceHome, join(directory.path, 'original'))
    await fs.mkdir(options.targetHome)
    await expect(migrateWorkbenchHome(options)).rejects.toThrow(/unknown or missing target/)
    await expect(fs.lstat(options.sourceHome)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects a replaced source and keeps the replacement untouched', async () => {
    await createSource()
    await interruptBeforeMove()
    await actual.rename(options.sourceHome, join(directory.path, 'original'))
    await fs.mkdir(options.sourceHome)
    await expect(migrateWorkbenchHome(options)).rejects.toThrow(/source identity changed/)
    expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
  })

  test.each(['sourceHome', 'targetHome'] as const)('binds the journal to %s', async field => {
    await createSource()
    await interruptBeforeMove()
    await expect(
      migrateWorkbenchHome({ ...options, [field]: join(directory.path, 'other') })
    ).rejects.toThrow(/mismatched.*journal/)
    expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
  })

  test('fails explicitly on EXDEV and permits a later same-filesystem retry', async () => {
    await createSource()
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error('cross device'), { code: 'EXDEV' })
    )
    await expect(migrateWorkbenchHome(options)).rejects.toThrow(/EXDEV.*copying is disabled/)
    expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
    await expect(fs.lstat(options.targetHome)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(migrateWorkbenchHome(options)).resolves.toBe('migrated')
  })

  test.each([false, true])(
    'refuses an explicitly managed source symlink (dangling: %s)',
    async dangling => {
      const external = join(directory.path, 'custom-home')
      if (!dangling) await fs.mkdir(external)
      await fs.mkdir(join(options.sourceHome, '..'), { recursive: true })
      await fs.symlink(external, options.sourceHome, 'dir')
      await expect(migrateWorkbenchHome(options)).rejects.toThrow(/externally managed/)
      expect(await fs.readlink(options.sourceHome)).toBe(external)
      expect(fs.rename).not.toHaveBeenCalled()
    }
  )

  test('refuses an unjournaled bridge even when it points at the requested target', async () => {
    await fs.mkdir(options.targetHome, { recursive: true })
    await fs.mkdir(join(options.sourceHome, '..'), { recursive: true })
    await fs.symlink(options.targetHome, options.sourceHome, 'dir')
    await expect(migrateWorkbenchHome(options)).rejects.toThrow(/externally managed/)
  })

  test.each(['../capabilities/store', '../../capabilities/store'])(
    'refuses unresolved external relative symlinks before moving anything: %s',
    async target => {
      await createSource()
      await fs.symlink(target, join(options.sourceHome, 'external'))
      await expect(migrateWorkbenchHome(options)).rejects.toThrow(
        /cannot verify a relative symlink/
      )
      expect(await fs.readlink(join(options.sourceHome, 'external'))).toBe(target)
      expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
      expect(fs.rename).not.toHaveBeenCalled()
    }
  )

  test('also detects an external relative symlink nested in a real directory', async () => {
    await createSource()
    await fs.symlink('../../capabilities/store', join(options.sourceHome, 'skills', 'external'))
    await expect(migrateWorkbenchHome(options)).rejects.toThrow(/cannot verify a relative symlink/)
    expect(fs.rename).not.toHaveBeenCalled()
  })

  test('rebases resolved external links without changing their destination', async () => {
    await createSource()
    await fs.mkdir(join(options.sourceHome, '..', 'capabilities', 'store'), { recursive: true })
    await fs.symlink('.', join(options.sourceHome, 'alias'), 'dir')
    await fs.symlink('alias/../capabilities/store', join(options.sourceHome, 'external'), 'dir')
    const destination = await fs.realpath(join(options.sourceHome, 'external'))
    await expect(migrateWorkbenchHome(options)).resolves.toBe('migrated')
    expect(await fs.readlink(join(options.targetHome, 'external'))).toBe(destination)
    expect(await fs.realpath(join(options.targetHome, 'external'))).toBe(destination)
  })

  test('recovers an interruption after rebasing a capability link before moving Home', async () => {
    await createSource()
    const external = join(options.sourceHome, '..', 'capabilities', 'store')
    await fs.mkdir(external, { recursive: true })
    await fs.writeFile(join(external, 'SKILL.md'), 'unchanged')
    await fs.symlink(
      '../../capabilities/store',
      join(options.sourceHome, 'skills', 'external'),
      'dir'
    )
    vi.mocked(fs.rename).mockImplementationOnce(async (source, target) => {
      await actual.rename(source, target)
      throw interrupted
    })
    await expect(migrateWorkbenchHome(options)).rejects.toBe(interrupted)
    expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
    await expect(migrateWorkbenchHome(options)).resolves.toBe('migrated')
    expect(
      await fs.readFile(join(options.targetHome, 'skills', 'external', 'SKILL.md'), 'utf8')
    ).toBe('unchanged')
    expect(await fs.readFile(join(external, 'SKILL.md'), 'utf8')).toBe('unchanged')
  })

  test('fails closed when a relative link cannot be resolved', async () => {
    await createSource()
    await fs.symlink('missing', join(options.sourceHome, 'unresolved'))
    await expect(migrateWorkbenchHome(options)).rejects.toThrow(/cannot verify a relative symlink/)
    expect(fs.rename).not.toHaveBeenCalled()
  })

  test('preserves absolute external links without traversing their targets', async () => {
    await createSource()
    const external = join(directory.path, 'external')
    await fs.mkdir(external)
    await fs.symlink('../outside', join(external, 'relative-external'))
    await fs.symlink(external, join(options.sourceHome, 'external'), 'dir')
    await fs.symlink(join(directory.path, 'missing'), join(options.sourceHome, 'dangling'))
    await expect(migrateWorkbenchHome(options)).resolves.toBe('migrated')
    expect(await fs.readlink(join(options.targetHome, 'external'))).toBe(external)
    expect(await fs.readlink(join(external, 'relative-external'))).toBe('../outside')
  })

  test('rejects overlapping paths before creating any migration state', async () => {
    await createSource()
    await expect(
      migrateWorkbenchHome({ ...options, targetHome: join(options.sourceHome, 'new') })
    ).rejects.toThrow(/overlap/)
    await expect(
      migrateWorkbenchHome({ ...options, stateDirectory: join(options.sourceHome, 'state') })
    ).rejects.toThrow(/overlap/)
    await expect(fs.lstat(options.stateDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects an active migration without touching its in-flight operation', async () => {
    await createSource()
    let entered!: () => void
    let proceed!: () => void
    const moving = new Promise<void>(accept => {
      entered = accept
    })
    const allowed = new Promise<void>(accept => {
      proceed = accept
    })
    vi.mocked(fs.rename).mockImplementationOnce(async (source, target) => {
      entered()
      await allowed
      await actual.rename(source, target)
    })
    const first = migrateWorkbenchHome(options)
    // Surface setup failures immediately instead of waiting for a test timeout.
    await Promise.race([moving, first])
    try {
      await expect(migrateWorkbenchHome(options)).rejects.toThrow(/lock unavailable/)
    } finally {
      proceed()
      await first
    }
    await assertBridge()
  })

  test('a lost lock aborts before creating a journal or moving the Home', async () => {
    await createSource()
    const release = vi.fn(async () => undefined)
    options.acquireLock = async () => ({
      assertHeld() {
        throw new Error('lock lost')
      },
      release,
    })
    await expect(migrateWorkbenchHome(options)).rejects.toThrow('lock lost')
    expect(release).toHaveBeenCalledOnce()
    expect((await fs.lstat(options.sourceHome)).isDirectory()).toBe(true)
    await expect(fs.lstat(options.stateDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
