import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

interface EntryMigration {
  source: string
  target: string
  journal: string
}

interface Journal extends EntryMigration {
  version: 1
  device: string
  inode: string
  directory: boolean
}

function stat(path: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function owns(path: string, journal: Journal): boolean {
  const entry = stat(path)
  return (
    !!entry &&
    (journal.directory ? entry.isDirectory() : entry.isFile()) &&
    entry.dev.toString() === journal.device &&
    entry.ino.toString() === journal.inode
  )
}

function readJournal(options: EntryMigration): Journal | undefined {
  const entry = stat(options.journal)
  if (!entry) return undefined
  if (!entry.isFile()) throw new Error('Application data migration journal must be a regular file')
  const journal = JSON.parse(fs.readFileSync(options.journal, 'utf8')) as Journal
  if (
    journal?.version !== 1 ||
    journal.source !== options.source ||
    journal.target !== options.target ||
    journal.journal !== options.journal ||
    typeof journal.directory !== 'boolean' ||
    typeof journal.device !== 'string' ||
    typeof journal.inode !== 'string' ||
    !/^\d+$/.test(journal.device) ||
    !/^\d+$/.test(journal.inode)
  )
    throw new Error('Invalid application data migration journal')
  return journal
}

function bridge(options: EntryMigration, directory: boolean): void {
  fs.symlinkSync(options.target, options.source, directory ? 'junction' : 'file')
}

// Recover only the missing alias before Electron creates its single-instance files.
// symlink is exclusive: concurrent startup cannot overwrite an existing entry.
export function recoverWorkbenchDataBridge(options: EntryMigration): void {
  const journal = readJournal(options)
  if (!journal || stat(options.source) || !owns(options.target, journal)) return
  try {
    bridge(options, journal.directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

function preserveRelativeLinks(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) preserveRelativeLinks(path)
    else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(path)
      if (isAbsolute(target)) continue
      // Keep the original spelling, including '..' after symlink components.
      // The legacy directory alias keeps internal and external links valid.
      const temporary = `${path}.migration-${randomUUID()}`
      let directory = false
      try {
        directory = fs.statSync(path).isDirectory()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      fs.symlinkSync(`${dirname(path)}${sep}${target}`, temporary, directory ? 'dir' : 'file')
      fs.renameSync(temporary, path)
    }
  }
}

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return !suffix || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

function canonicalParent(path: string): string {
  const parent = dirname(path)
  if (parent === path) return fs.realpathSync(path)
  if (stat(parent)) return join(fs.realpathSync(parent), relative(parent, path))
  return join(canonicalParent(parent), relative(parent, path))
}

// Synchronous by design: userData/sessionData must move before Electron's ready event.
// Caller owns the app single-instance lock (or the executor migration lock).
// Rename preserves the complete SQLite/WAL/SHM set and credentials without copying.
export function migrateWorkbenchDataEntry(options: EntryMigration): void {
  const { source, target, journal: journalPath } = options
  const paths = [source, target, journalPath]
  if (paths.some(path => !isAbsolute(path)))
    throw new Error('Application data migration paths must be absolute')
  const [canonicalSource, canonicalTarget, canonicalJournal] = paths.map(path =>
    canonicalParent(resolve(path))
  )
  if (
    contains(canonicalSource, canonicalTarget) ||
    contains(canonicalTarget, canonicalSource) ||
    contains(canonicalSource, canonicalJournal) ||
    contains(canonicalTarget, canonicalJournal)
  ) {
    throw new Error('Application data migration paths must be absolute and disjoint')
  }
  let journal = readJournal(options)
  const original = stat(source)
  if (!journal) {
    if (!original) {
      if (stat(target)) throw new Error(`Application data migration target conflict: ${target}`)
      return
    }
    if (!original.isDirectory() && !original.isFile()) {
      throw new Error(`Application data migration source is externally managed: ${source}`)
    }
    if (stat(target)) throw new Error(`Application data migration target conflict: ${target}`)
    journal = {
      ...options,
      version: 1,
      device: original.dev.toString(),
      inode: original.ino.toString(),
      directory: original.isDirectory(),
    }
    fs.mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 })
    const temporary = `${journalPath}.${randomUUID()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(journal), { flag: 'wx', mode: 0o600 })
    fs.linkSync(temporary, journalPath)
    fs.unlinkSync(temporary)
  }
  if (original?.isSymbolicLink()) {
    const destination = stat(target)
    if (
      journal.directory
        ? destination?.isDirectory() &&
          destination.ino.toString() === journal.inode &&
          fs.realpathSync(source) === fs.realpathSync(target)
        : resolve(dirname(source), fs.readlinkSync(source)) === resolve(target)
    ) {
      // A completed bridge identifies its destination even when st_dev changes after a remount.
      // Keep the directory inode check; files may be atomically replaced or removed by SQLite.
      return
    }
  }
  if (original) {
    if (!owns(source, journal) || stat(target)) {
      throw new Error(`Application data migration conflict: ${source}`)
    }
    fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    if (journal.directory) preserveRelativeLinks(source)
    // Check link privileges before moving any data; never fall back to copying.
    const probe = `${source}.migration-${randomUUID()}`
    fs.symlinkSync(target, probe, journal.directory ? 'junction' : 'file')
    fs.unlinkSync(probe)
    fs.renameSync(source, target)
  }
  if (!owns(target, journal)) throw new Error('Application data migration target identity changed')
  bridge(options, journal.directory)
}
