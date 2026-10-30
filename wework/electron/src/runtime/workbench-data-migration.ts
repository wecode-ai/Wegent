import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { renameWorkbenchData } from './workbench-data-rename.js'

interface EntryMigration {
  source: string
  target: string
  journal: string
  mutableFile?: boolean
}

interface FileIdentity {
  device: string
  inode: string
}

interface Journal extends EntryMigration, FileIdentity {
  version: 1
  directory: boolean
  completed?: true
  hardLink?: true
  replacement?: FileIdentity
}

function stat(path: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function owns(path: string, journal: FileIdentity & { directory?: boolean }): boolean {
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
    !/^\d+$/.test(journal.inode) ||
    (journal.completed !== undefined && journal.completed !== true) ||
    (journal.hardLink !== undefined && (journal.hardLink !== true || journal.directory)) ||
    (journal.replacement !== undefined &&
      (!journal.replacement ||
        !options.mutableFile ||
        journal.directory ||
        !journal.completed ||
        typeof journal.replacement.device !== 'string' ||
        typeof journal.replacement.inode !== 'string' ||
        !/^\d+$/.test(journal.replacement.device) ||
        !/^\d+$/.test(journal.replacement.inode)))
  )
    throw new Error('Invalid application data migration journal')
  return journal
}

function bridge(options: EntryMigration, directory: boolean): void {
  if (process.platform === 'win32' && !directory) fs.linkSync(options.target, options.source)
  else fs.symlinkSync(options.target, options.source, directory ? 'junction' : 'file')
}

function replaceJournal(journal: Journal): void {
  const temporary = `${journal.journal}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(journal), {
    flag: 'wx',
    mode: 0o600,
  })
  renameWorkbenchData(temporary, journal.journal)
}

function complete(journal: Journal): void {
  if (!journal.directory && !journal.completed) replaceJournal({ ...journal, completed: true })
}

// Atomic configuration writes replace the destination inode. Persist its new
// identity before replacing the owned legacy alias so interrupted refreshes recover.
function refreshMutableFileBridge(options: EntryMigration, journal: Journal): boolean {
  if (
    process.platform !== 'win32' ||
    !options.mutableFile ||
    journal.directory ||
    !journal.completed
  )
    return false
  const destination = stat(options.target)
  if (!destination?.isFile()) return false
  const original = stat(options.source)
  let replacement = journal.replacement
  if (!replacement) {
    if ((original && !owns(options.source, journal)) || owns(options.target, journal)) return false
    replacement = { device: destination.dev.toString(), inode: destination.ino.toString() }
    journal = { ...journal, replacement }
    replaceJournal(journal)
  }
  if (
    !owns(options.target, replacement) ||
    (original && !owns(options.source, journal) && !owns(options.source, replacement))
  )
    throw new Error(`Application data migration conflict: ${options.source}`)
  const temporary = `${options.source}.migration-file-bridge`
  const pending = stat(temporary)
  if (pending && !owns(temporary, replacement))
    throw new Error('Application data migration temporary file conflict')
  if (!original || !owns(options.source, replacement)) {
    if (!pending) fs.linkSync(options.target, temporary)
    renameWorkbenchData(temporary, options.source)
  } else if (pending) fs.unlinkSync(temporary)
  const completed = { ...journal, ...replacement }
  delete completed.replacement
  replaceJournal(completed)
  return true
}

// Recover aliases before Electron creates its single-instance files.
// symlink is exclusive: concurrent startup cannot overwrite an existing entry.
export function recoverWorkbenchDataBridge(options: EntryMigration): void {
  const journal = readJournal(options)
  if (!journal || (!owns(options.target, journal) && !(journal.completed && !journal.directory)))
    return
  const original = stat(options.source)
  if (original) return
  if (process.platform === 'win32' && !journal.directory) {
    if (!stat(options.target)) return
    if (refreshMutableFileBridge(options, journal)) return
    if (!owns(options.target, journal))
      throw new Error('Application data migration target identity changed')
  }
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
      renameWorkbenchData(temporary, path)
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

function validateMigrationPaths(options: EntryMigration): void {
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
}

// Synchronous by design: userData/sessionData must move before Electron's ready event.
// Caller owns the app single-instance lock (or the executor migration lock).
// Rename preserves the complete SQLite/WAL/SHM set and credentials without copying.
export function migrateWorkbenchDataEntry(options: EntryMigration): void {
  const { source, target, journal: journalPath } = options
  validateMigrationPaths(options)
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
      ...(process.platform === 'win32' && original.isFile() ? { hardLink: true as const } : {}),
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
      complete(journal)
      return
    }
  }
  // Existing native aliases require completion or our publication intent, plus
  // matching file identities. Pending mutable refreshes must be recovered below.
  if (
    !journal.directory &&
    !journal.replacement &&
    (journal.completed || journal.hardLink) &&
    owns(source, journal) &&
    owns(target, journal)
  ) {
    complete(journal)
    return
  }
  if (refreshMutableFileBridge(options, journal)) return
  // SQLite may remove both an old sidecar alias and its migrated destination after use.
  // Only a previously published file bridge can be recreated without the initial inode.
  if (!original && journal.completed && !journal.directory) {
    if (process.platform === 'win32' && !stat(target)) return
    if (process.platform === 'win32' && !owns(target, journal))
      throw new Error('Application data migration target identity changed')
    bridge(options, false)
    return
  }
  if (original) {
    if (!owns(source, journal) || stat(target)) {
      throw new Error(`Application data migration conflict: ${source}`)
    }
    if (process.platform === 'win32' && !journal.directory && !journal.hardLink) {
      journal = { ...journal, hardLink: true }
      replaceJournal(journal)
    }
    fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    if (journal.directory) preserveRelativeLinks(source)
    // Prove native alias publication before moving data; never copy credentials.
    const probe = `${source}.migration-${randomUUID()}`
    if (process.platform === 'win32' && !journal.directory) fs.linkSync(source, probe)
    else fs.symlinkSync(target, probe, journal.directory ? 'junction' : 'file')
    fs.unlinkSync(probe)
    renameWorkbenchData(source, target)
  }
  if (!owns(target, journal)) throw new Error('Application data migration target identity changed')
  bridge(options, journal.directory)
  complete(journal)
}
