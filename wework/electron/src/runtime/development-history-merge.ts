import * as fs from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { replayProjectState, type ProjectStateProjector } from './workbench-project-state.js'

export const HISTORY_MARKER = 'migrations/legacy-development-history-v1.json'
const JOURNAL = '.development-history-publication.json'

async function stat(path: string) {
  try {
    return await fs.lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function fileIdentity(path: string): Promise<string | null> {
  const info = await stat(path)
  if (!info) return null
  if (!info.isFile()) throw new Error('Development history destination must be a regular file')
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`
}

async function safePath(root: string, suffix: string): Promise<string> {
  const rootInfo = await stat(root)
  if (rootInfo && !rootInfo.isDirectory())
    throw new Error('Development history parent is not a real directory')
  if (
    !suffix ||
    isAbsolute(suffix) ||
    suffix.split(sep).some(part => part === '..' || part === '.')
  )
    throw new Error('Invalid development history publication path')
  let parent = root
  for (const part of suffix.split(sep).slice(0, -1)) {
    parent = join(parent, part)
    const info = await stat(parent)
    if (info && !info.isDirectory())
      throw new Error('Development history parent is not a real directory')
  }
  return join(root, suffix)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid development history object')
  return value as Record<string, unknown>
}

async function readObject(path: string) {
  await fileIdentity(path)
  try {
    return object(JSON.parse(await fs.readFile(path, 'utf8')))
  } catch {
    throw new Error(`Invalid development history JSON: ${path}`)
  }
}

function mergeRecords(incoming: unknown, current: unknown): Record<string, unknown> {
  const result = { ...object(incoming ?? {}) }
  for (const [key, value] of Object.entries(object(current ?? {}))) {
    if (Object.hasOwn(result, key) && !isDeepStrictEqual(result[key], value))
      throw new Error('Development history ID conflict; existing data was not changed')
    result[key] = value
  }
  return result
}

// Current preferences win; list entries and map keys unique to the import are retained.
function mergePreferences(incoming: unknown, current: unknown): unknown {
  if (Array.isArray(incoming) && Array.isArray(current))
    return [
      ...current,
      ...incoming.filter(
        item =>
          !current.some(value => {
            if (isDeepStrictEqual(item, value)) return true
            return (
              item &&
              value &&
              typeof item === 'object' &&
              typeof value === 'object' &&
              typeof item.id === 'string' &&
              item.id === value.id
            )
          })
      ),
    ]
  if (
    incoming &&
    current &&
    typeof incoming === 'object' &&
    typeof current === 'object' &&
    !Array.isArray(incoming) &&
    !Array.isArray(current)
  ) {
    const result = { ...object(incoming) }
    for (const [key, value] of Object.entries(object(current)))
      result[key] = Object.hasOwn(result, key) ? mergePreferences(result[key], value) : value
    return result
  }
  return current
}

function identifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`
}

async function mergeDatabase(incomingPath: string, currentPath: string, tables: Set<string>) {
  const incoming = new DatabaseSync(incomingPath, { readOnly: true })
  const current = new DatabaseSync(currentPath, { readOnly: true })
  const mergedPath = `${incomingPath}.merged`
  try {
    await backup(current, mergedPath)
    const merged = new DatabaseSync(mergedPath)
    try {
      merged.exec('PRAGMA foreign_keys=OFF; BEGIN')
      for (const entry of incoming
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()) {
        const table = String(entry.name)
        if (!tables.has(table) || table === '_sqlx_migrations') continue
        const name = identifier(table)
        const schema = incoming.prepare(`PRAGMA table_info(${name})`).all()
        if (!isDeepStrictEqual(schema, merged.prepare(`PRAGMA table_info(${name})`).all()))
          throw new Error(`Development history schema mismatch: ${table}`)
        const columns = schema.map(row => String(row.name))
        const keys = schema.filter(row => Number(row.pk) > 0).map(row => String(row.name))
        const select = incoming.prepare(`SELECT * FROM ${name}`)
        select.setReadBigInts(true)
        const insert = merged.prepare(
          `INSERT INTO ${name} (${columns.map(identifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
        )
        const lookupColumns = keys.length ? keys : columns
        const lookup = merged.prepare(
          `SELECT * FROM ${name} WHERE ${lookupColumns.map(column => `${identifier(column)} IS ?`).join(' AND ')}`
        )
        lookup.setReadBigInts(true)
        for (const row of select.iterate()) {
          const existing = lookup.get(...lookupColumns.map(column => row[column]!))
          if (existing) {
            if (!isDeepStrictEqual(existing, row))
              throw new Error(
                `Development history ID conflict in ${table}; existing data was not changed`
              )
          } else insert.run(...columns.map(column => row[column]!))
        }
      }
      merged.exec('COMMIT')
      if (merged.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw new Error('Merged development database failed integrity verification')
    } finally {
      merged.close()
    }
  } finally {
    current.close()
    incoming.close()
  }
  await fs.chmod(mergedPath, 0o600)
  await fs.rename(mergedPath, incomingPath)
}

export async function mergeDevelopmentHistory(
  stage: string,
  target: string,
  tables: Set<string>,
  historyTables: Set<string>,
  projectState?: ProjectStateProjector
): Promise<void> {
  for (const [suffix, selected] of [
    ['codex/state_5.sqlite', tables],
    ['codex/thread_history_1.sqlite', historyTables],
  ] as const) {
    const current = await safePath(target, suffix)
    if ((await fileIdentity(current)) && (await stat(join(stage, suffix))))
      await mergeDatabase(join(stage, suffix), current, selected)
  }
  for (const suffix of ['runtime-work/index.json', 'codex/.codex-global-state.json']) {
    const currentPath = await safePath(target, suffix)
    const incomingPath = join(stage, suffix)
    const hasCurrent = !!(await fileIdentity(currentPath))
    const hasIncoming = !!(await stat(incomingPath))
    if (suffix === 'runtime-work/index.json' && (!hasCurrent || !hasIncoming)) continue
    const current = hasCurrent ? await readObject(currentPath) : {}
    const incoming = hasIncoming ? await readObject(incomingPath) : {}
    let merged: unknown
    if (suffix === 'runtime-work/index.json') {
      if (current.version !== 1 || incoming.version !== 1)
        throw new Error('Unsupported development runtime history format')
      const tasks = mergeRecords(incoming.tasks, current.tasks)
      const deleted = mergeRecords(
        incoming.deleted_archived_task_ids,
        current.deleted_archived_task_ids
      )
      if (Object.keys(deleted).some(id => Object.hasOwn(tasks, id)))
        throw new Error(
          'Development history conflicts with a deleted task; existing data was not changed'
        )
      merged = {
        ...incoming,
        ...current,
        tasks,
        workspaces: mergeRecords(incoming.workspaces, current.workspaces),
        deleted_archived_task_ids: deleted,
      }
    } else {
      // Replay the new Home's operations last, so its removals/renames win over the import.
      const oplog = 'runtime-work/.codex-global-state.oplog.jsonl'
      const currentLog = await safePath(target, oplog)
      const hasLog = !!(await fileIdentity(currentLog))
      const operations = hasLog ? await fs.readFile(currentLog, 'utf8') : ''
      if (!hasCurrent && !hasIncoming && !operations.trim()) continue
      merged = await replayProjectState(
        object(mergePreferences(incoming, current)),
        operations,
        projectState
      )
      if (hasLog) {
        await fs.mkdir(join(stage, 'runtime-work'), { recursive: true, mode: 0o700 })
        await fs.writeFile(join(stage, oplog), '', { mode: 0o600 })
      }
    }
    await fs.mkdir(dirname(incomingPath), { recursive: true, mode: 0o700 })
    await fs.writeFile(incomingPath, JSON.stringify(merged), { mode: 0o600 })
  }
}

interface PublicationEntry {
  path: string
  before: string | null
  after: string | null
}
interface Publication {
  version: number
  target: string
  stage: string
  entries: PublicationEntry[]
}

async function files(root: string, directory = root): Promise<string[]> {
  const result: string[] = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await files(root, path)))
    else if (entry.isFile()) result.push(relative(root, path))
    else throw new Error('Unexpected development history staging entry')
  }
  return result
}

export async function recoverDevelopmentPublication(
  target: string,
  assertHeld: () => void
): Promise<void> {
  const journalPath = join(dirname(target), JOURNAL)
  if (!(await stat(journalPath))) return
  const journal = (await readObject(journalPath)) as unknown as Publication
  if (
    journal.version !== 1 ||
    journal.target !== target ||
    typeof journal.stage !== 'string' ||
    dirname(journal.stage) !== dirname(target) ||
    !journal.stage.startsWith(join(dirname(target), '.development-history-')) ||
    !Array.isArray(journal.entries) ||
    !journal.entries.length ||
    journal.entries.at(-1)?.path !== HISTORY_MARKER ||
    !(await stat(journal.stage))?.isDirectory()
  )
    throw new Error('Invalid development history publication journal')
  for (const entry of journal.entries) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !(entry.before === null || typeof entry.before === 'string') ||
      !(entry.after === null || typeof entry.after === 'string')
    )
      throw new Error('Invalid development history publication entry')
    await safePath(target, entry.path)
    await safePath(journal.stage, entry.path)
    await safePath(join(journal.stage, '.rollback'), entry.path)
  }
  const committed =
    (await fileIdentity(join(target, HISTORY_MARKER))) === journal.entries.at(-1)!.after
  if (!committed) {
    for (const entry of [...journal.entries].reverse()) {
      assertHeld()
      const path = await safePath(target, entry.path)
      const saved = join(journal.stage, '.rollback', entry.path)
      const current = await fileIdentity(path)
      if (current === entry.before && !(await stat(saved))) continue
      if (current !== null && current !== entry.after)
        throw new Error('Development history changed during recovery; refusing to overwrite it')
      if (entry.before !== null && (await fileIdentity(saved)) !== entry.before)
        throw new Error('Development history recovery backup is missing or changed')
      if (current !== null) await fs.unlink(path)
      if (entry.before !== null) await fs.rename(saved, path)
    }
  }
  // Once resolved, the journal must disappear before its staging/backup files.
  assertHeld()
  await fs.unlink(journalPath)
  await fs.rm(journal.stage, { recursive: true, force: true })
}

export async function publishDevelopmentHistory(
  stage: string,
  target: string,
  assertHeld: () => void
): Promise<void> {
  const suffixes = (await files(stage)).filter(path => path !== HISTORY_MARKER)
  const entries: PublicationEntry[] = []
  for (const suffix of [...suffixes, HISTORY_MARKER]) {
    const path = await safePath(target, suffix)
    const before = await fileIdentity(path)
    if (before && /^(codex\/(archived_)?sessions\/)/.test(suffix))
      throw new Error('Development rollout path conflict; existing data was not changed')
    entries.push({ path: suffix, before, after: await fileIdentity(join(stage, suffix)) })
    if (suffix.endsWith('.sqlite'))
      for (const ending of ['-wal', '-shm']) {
        const sidecar = suffix + ending
        const identity = await fileIdentity(await safePath(target, sidecar))
        if (identity) entries.push({ path: sidecar, before: identity, after: null })
      }
  }
  const journalPath = join(dirname(target), JOURNAL)
  const temporary = join(stage, '.publication-journal')
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify({ version: 1, target, stage, entries }))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.link(temporary, journalPath)
  try {
    for (const entry of entries) {
      assertHeld()
      const path = await safePath(target, entry.path)
      if ((await fileIdentity(path)) !== entry.before)
        throw new Error('Development history changed during publication')
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
      if (entry.before !== null) {
        const saved = join(stage, '.rollback', entry.path)
        await fs.mkdir(dirname(saved), { recursive: true, mode: 0o700 })
        await fs.rename(path, saved)
      }
      if (entry.after !== null) await fs.rename(join(stage, entry.path), path)
    }
  } finally {
    await recoverDevelopmentPublication(target, assertHeld)
  }
}

export async function hasDevelopmentPublication(target: string): Promise<boolean> {
  return !!(await stat(join(dirname(target), JOURNAL)))
}
