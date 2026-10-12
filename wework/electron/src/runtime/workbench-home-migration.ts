import { randomUUID } from 'node:crypto'
import { type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WorkbenchMigrationLockAdapter } from './workbench-migration-lock.js'

export interface WorkbenchHomeMigrationOptions {
  acquireLock: WorkbenchMigrationLockAdapter
  sourceHome: string
  targetHome: string
  stateDirectory: string
  initialize?: boolean
  preserveExistingSource?: boolean
  beforeMove?: (sourceHome: string) => Promise<void>
}

export type WorkbenchHomeMigrationResult = 'migrated' | 'already-migrated' | 'no-source'

interface MigrationJournal {
  version: 1
  sourceHome: string
  targetHome: string
  device: string
  inode: string
  token: string
  strategy?: 'preserve-source' | 'relocate-source'
  links?: Array<{ path: string; original: string; destination: string }>
}

const JOURNAL_NAME = 'workbench-home-migration.json'

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

async function metadata(path: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.lstat(path, { bigint: true })
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
}

// Resolve parent aliases without following a Home's final symlink.
async function canonicalParent(path: string): Promise<string> {
  const parent = dirname(path)
  if (parent === path) return fs.realpath(path)
  try {
    return join(await fs.realpath(parent), relative(parent, path))
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
    return join(await canonicalParent(parent), relative(parent, path))
  }
}

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

async function normalizeOptions(
  options: WorkbenchHomeMigrationOptions
): Promise<WorkbenchHomeMigrationOptions> {
  const paths = [options.sourceHome, options.targetHome, options.stateDirectory]
  if (paths.some(path => !isAbsolute(path))) {
    throw new Error('Workbench Home migration requires absolute paths')
  }
  const [sourceHome, targetHome, stateDirectory] = await Promise.all(
    paths.map(path => canonicalParent(resolve(path)))
  )
  if (
    contains(sourceHome, targetHome) ||
    contains(targetHome, sourceHome) ||
    contains(sourceHome, stateDirectory) ||
    contains(targetHome, stateDirectory)
  ) {
    throw new Error('Workbench Home migration paths must not overlap')
  }
  return { ...options, sourceHome, targetHome, stateDirectory }
}

async function readJournal(
  path: string,
  options: WorkbenchHomeMigrationOptions
): Promise<MigrationJournal | undefined> {
  const entry = await metadata(path)
  if (!entry) return undefined
  if (!entry.isFile()) throw new Error('Invalid Workbench Home migration journal')
  const journal: Partial<MigrationJournal> | null = JSON.parse(await fs.readFile(path, 'utf8'))
  if (
    journal?.version !== 1 ||
    journal.sourceHome !== options.sourceHome ||
    journal.targetHome !== options.targetHome ||
    typeof journal.device !== 'string' ||
    !/^\d+$/.test(journal.device) ||
    typeof journal.inode !== 'string' ||
    !/^\d+$/.test(journal.inode) ||
    typeof journal.token !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(journal.token) ||
    (journal.strategy !== undefined &&
      journal.strategy !== 'preserve-source' &&
      journal.strategy !== 'relocate-source')
  ) {
    throw new Error('Invalid or mismatched Workbench Home migration journal')
  }
  if (
    journal.links !== undefined &&
    (!Array.isArray(journal.links) ||
      journal.links.some(
        link =>
          !link ||
          typeof link.path !== 'string' ||
          isAbsolute(link.path) ||
          !link.path ||
          !contains(options.sourceHome, resolve(options.sourceHome, link.path)) ||
          typeof link.original !== 'string' ||
          isAbsolute(link.original) ||
          typeof link.destination !== 'string' ||
          !isAbsolute(link.destination)
      ))
  )
    throw new Error('Invalid Workbench Home migration link journal')
  return journal as MigrationJournal
}

async function writeJournal(
  path: string,
  journal: MigrationJournal,
  replace = false
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(journal)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    // Hard-link publication is atomic and cannot replace an existing journal.
    if (replace) await fs.rename(temporary, path)
    else await fs.link(temporary, path)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

function ownsDirectory(entry: BigIntStats | undefined, journal: MigrationJournal): boolean {
  return (
    !!entry?.isDirectory() &&
    entry.dev.toString() === journal.device &&
    entry.ino.toString() === journal.inode
  )
}

async function collectRelativeLinks(
  home: string,
  directory = home,
  links: NonNullable<MigrationJournal['links']> = []
): Promise<NonNullable<MigrationJournal['links']>> {
  const entries = await fs.opendir(directory)
  for await (const entry of entries) {
    const path = join(directory, entry.name)
    const info = await fs.lstat(path)
    if (info.isSymbolicLink()) {
      const target = await fs.readlink(path)
      if (isAbsolute(target)) continue
      // Lexical containment alone misses paths such as "alias/../outside".
      // realpath reads link metadata, not file contents or directory trees.
      let destination: string
      try {
        destination = await fs.realpath(path)
      } catch (error) {
        throw new Error(`Workbench Home migration cannot verify a relative symlink: ${path}`, {
          cause: error,
        })
      }
      if (!contains(home, destination)) {
        links.push({ path: relative(home, path), original: target, destination })
      }
    } else if (info.isDirectory()) {
      await collectRelativeLinks(home, path, links)
    }
  }
  return links
}

// Rebase only the symlink itself, never traverse or modify its external target.
// Journaled originals make interrupted rewrites idempotent before the Home move.
async function repairRelativeLinks(home: string, journal: MigrationJournal): Promise<void> {
  for (const link of journal.links || []) {
    const path = join(home, link.path)
    if (!contains(home, await fs.realpath(dirname(path)))) {
      throw new Error('Workbench Home migration relative link parent changed')
    }
    if (!(await metadata(path))?.isSymbolicLink()) {
      throw new Error('Workbench Home migration relative link changed')
    }
    const value = await fs.readlink(path)
    if (value === link.destination) continue
    if (value !== link.original) throw new Error('Workbench Home migration relative link changed')
    const temporary = `${path}.migration-${journal.token}.tmp`
    const pending = await metadata(temporary)
    if (pending) {
      if (!pending.isSymbolicLink() || (await fs.readlink(temporary)) !== link.destination) {
        throw new Error('Workbench Home migration temporary relative link conflict')
      }
    } else {
      const target = await fs.stat(path)
      await fs.symlink(link.destination, temporary, target.isDirectory() ? 'dir' : 'file')
    }
    await fs.rename(temporary, path)
  }
}

async function assertAbsent(path: string): Promise<void> {
  if (await metadata(path)) throw new Error(`Workbench Home migration path conflict: ${path}`)
}

async function prepareBridge(
  options: WorkbenchHomeMigrationOptions,
  journal: MigrationJournal
): Promise<string> {
  const { sourceHome, targetHome } = options
  const temporary = `${sourceHome}.migration-${journal.token}.tmp`
  const pending = await metadata(temporary)
  if (pending) {
    if (!pending.isSymbolicLink() || (await fs.readlink(temporary)) !== targetHome) {
      throw new Error('Workbench Home migration temporary link conflict')
    }
  } else {
    await fs.symlink(targetHome, temporary, 'dir')
  }
  if (
    !(await metadata(temporary))?.isSymbolicLink() ||
    (await fs.readlink(temporary)) !== targetHome
  ) {
    throw new Error('Workbench Home migration temporary link verification failed')
  }
  return temporary
}

async function publishBridge(
  options: WorkbenchHomeMigrationOptions,
  journal: MigrationJournal
): Promise<void> {
  const { sourceHome, targetHome } = options
  if (!ownsDirectory(await metadata(targetHome), journal)) {
    throw new Error('Workbench Home migration target identity changed')
  }
  const temporary = await prepareBridge(options, journal)
  await assertAbsent(sourceHome)
  await fs.rename(temporary, sourceHome)
}

async function resumeMigration(
  options: WorkbenchHomeMigrationOptions,
  journal: MigrationJournal,
  assertHeld: () => void
): Promise<WorkbenchHomeMigrationResult> {
  const { sourceHome, targetHome } = options
  const source = await metadata(sourceHome)
  const target = await metadata(targetHome)
  assertHeld()
  if (journal.strategy === 'preserve-source') {
    if (!ownsDirectory(source, journal)) {
      throw new Error('Workbench Home migration source identity changed')
    }
    if (target?.isSymbolicLink() && (await fs.readlink(targetHome)) === sourceHome) {
      return 'already-migrated'
    }
    await assertAbsent(targetHome)
    await fs.mkdir(dirname(targetHome), { recursive: true, mode: 0o700 })
    assertHeld()
    await publishBridge({ ...options, sourceHome: targetHome, targetHome: sourceHome }, journal)
    return 'migrated'
  }
  if (source?.isSymbolicLink()) {
    // st_dev can change after a remount. A completed bridge still identifies the
    // original directory by its inode and exact canonical destination.
    if (
      target?.isDirectory() &&
      target.ino.toString() === journal.inode &&
      (await fs.readlink(sourceHome)) === targetHome &&
      (await fs.realpath(sourceHome)) === (await fs.realpath(targetHome))
    ) {
      return 'already-migrated'
    }
    throw new Error('Workbench Home migration source symlink conflict')
  }
  if (source) {
    if (!ownsDirectory(source, journal))
      throw new Error('Workbench Home migration source identity changed')
    if (journal.strategy === 'relocate-source' && target?.isSymbolicLink()) {
      if ((await fs.readlink(targetHome)) !== sourceHome) {
        throw new Error('Workbench Home migration target symlink conflict')
      }
      await fs.unlink(targetHome)
    }
    await assertAbsent(targetHome)
    await repairRelativeLinks(sourceHome, journal)
    assertHeld()
    if ((await collectRelativeLinks(sourceHome)).length) {
      throw new Error('Workbench Home migration found an unjournaled external relative link')
    }
    await fs.mkdir(dirname(targetHome), { recursive: true, mode: 0o700 })
    // Prove directory symlink privileges before making the old Home unavailable.
    await prepareBridge(options, journal)
    await assertAbsent(targetHome)
    assertHeld()
    try {
      await fs.rename(sourceHome, targetHome)
    } catch (error) {
      if (hasCode(error, 'EXDEV')) {
        throw new Error(
          'Workbench Home migration requires the same filesystem (EXDEV); copying is disabled',
          { cause: error }
        )
      }
      throw error
    }
  } else if (!ownsDirectory(target, journal)) {
    throw new Error('Workbench Home migration cannot recover an unknown or missing target')
  }
  assertHeld()
  await publishBridge(options, journal)
  return 'migrated'
}

/**
 * Call before starting any executor. The caller must exclusively control both
 * Home paths and their parents, and reuse one persistent stateDirectory.
 * The mover reads only metadata and symlink targets. beforeMove may inspect
 * configuration under the same lock, but must not read credential contents.
 * External relative links are journaled and rebased without reading target data.
 * Unresolvable relative links fail closed rather than changing their meaning.
 * The journal supports process-crash recovery, not power-loss durability.
 */
export async function migrateWorkbenchHome(
  input: WorkbenchHomeMigrationOptions
): Promise<WorkbenchHomeMigrationResult> {
  const options = await normalizeOptions(input)
  const lock = await options.acquireLock([
    options.sourceHome,
    options.targetHome,
    options.stateDirectory,
  ])
  try {
    const { sourceHome, targetHome, stateDirectory } = options
    const state = await metadata(stateDirectory)
    lock.assertHeld()
    if (state && !state.isDirectory()) throw new Error('Migration state must be a real directory')
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    const journalPath = join(stateDirectory, JOURNAL_NAME)
    let existing = await readJournal(journalPath, options)
    let source = await metadata(sourceHome)
    if (source?.isDirectory() && !options.preserveExistingSource) {
      await options.beforeMove?.(sourceHome)
      lock.assertHeld()
      if (existing?.strategy === 'preserve-source') {
        if (!ownsDirectory(source, existing))
          throw new Error('Workbench Home migration source identity changed')
        const target = await metadata(targetHome)
        if (
          target &&
          (!target.isSymbolicLink() || (await fs.readlink(targetHome)) !== sourceHome)
        ) {
          throw new Error('Workbench Home migration target conflict')
        }
        // Persist the conversion before removing the old reverse bridge so restart
        // can recover before/after unlink, rename, and final bridge publication.
        existing = {
          ...existing,
          strategy: 'relocate-source',
          links: await collectRelativeLinks(sourceHome),
        }
        lock.assertHeld()
        await writeJournal(journalPath, existing, true)
      }
    }
    if (existing) return await resumeMigration(options, existing, lock.assertHeld)
    const preserveSource = !!source && options.preserveExistingSource
    const target = await metadata(targetHome)
    if (!source) {
      lock.assertHeld()
      if (options.initialize) {
        // Never adopt an existing target without its inode-bound journal.
        await assertAbsent(targetHome)
        await fs.mkdir(dirname(sourceHome), { recursive: true, mode: 0o700 })
        await fs.mkdir(sourceHome, { mode: 0o700 })
        source = await metadata(sourceHome)
      } else {
        if (target && !target.isDirectory())
          throw new Error('Workbench Home migration target conflict')
        return 'no-source'
      }
    }
    if (!source) throw new Error('Workbench Home initialization failed')
    if (source.isSymbolicLink())
      throw new Error('Workbench Home source symlink is externally managed')
    if (!source.isDirectory()) throw new Error('Workbench Home source must be a directory')
    await assertAbsent(targetHome)
    const journal: MigrationJournal = {
      version: 1,
      sourceHome,
      targetHome,
      device: source.dev.toString(),
      inode: source.ino.toString(),
      token: randomUUID(),
      ...(preserveSource ? { strategy: 'preserve-source' as const } : {}),
      links: preserveSource ? [] : await collectRelativeLinks(sourceHome),
    }
    lock.assertHeld()
    await writeJournal(journalPath, journal)
    return await resumeMigration(options, journal, lock.assertHeld)
  } finally {
    await lock.release()
  }
}
