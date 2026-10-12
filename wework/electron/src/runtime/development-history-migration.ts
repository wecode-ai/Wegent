import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import {
  executorProjectStateProjector,
  replayProjectState,
  type ProjectStateProjector,
} from './workbench-project-state.js'

import {
  HISTORY_MARKER as MARKER,
  hasDevelopmentPublication,
  mergeDevelopmentHistory,
  publishDevelopmentHistory,
  recoverDevelopmentPublication,
} from './development-history-merge.js'
import {
  executorMigrationLock,
  type WorkbenchMigrationLockAdapter,
} from './workbench-migration-lock.js'

const execute = promisify(execFile)
const HISTORY_TABLES = new Set([
  '_sqlx_migrations',
  'threads',
  'thread_dynamic_tools',
  'thread_spawn_edges',
  'thread_sections',
  'projects',
  'project_roots',
  'thread_artifacts',
])
const TURN_HISTORY_TABLES = new Set([
  '_sqlx_migrations',
  'thread_turns',
  'thread_items',
  'thread_history_projection_state',
  'thread_realtime_items',
])
const PROJECT_KEYS = new Set([
  'electron-saved-workspace-roots',
  'electron-workspace-root-labels',
  'local-projects',
  'project-writable-roots',
  'project-appearances',
  'project-order',
  'active-workspace-roots',
  'active-remote-project-id',
  'selected-remote-host-id',
  'pinned-project-ids',
  'pinned-thread-ids',
  'sidebar-project-thread-orders',
  'thread-project-assignments',
  'remote-projects',
  'projectless-thread-ids',
  'thread-workspace-root-hints',
])

interface HistoryMigrationOptions {
  sourceHome: string
  targetHome: string
  previousIsolatedHome?: string
  importLegacy: boolean
  acquireLock: WorkbenchMigrationLockAdapter
  assertIdle: (home: string) => Promise<void>
  projectState?: ProjectStateProjector
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  if (!(await exists(path))) return null
  if (!(await fs.lstat(path)).isFile())
    throw new Error('Development history JSON must be a regular file')
  let value: unknown
  try {
    value = JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    throw new Error(`Cannot parse development history JSON: ${path}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid development history JSON: ${path}`)
  }
  return value as Record<string, unknown>
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await fs.writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return !!suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
}

async function assertRealPath(root: string, path: string): Promise<void> {
  if (!within(await fs.realpath(root), await fs.realpath(path))) {
    throw new Error('Development history links outside the selected source; import refused')
  }
}

async function hasHistory(home: string, codexHome = join(home, 'codex')): Promise<boolean> {
  if (!(await exists(home))) return false
  if (!(await fs.lstat(home)).isDirectory())
    throw new Error('Development source Home must be a real directory')
  for (const path of [join(home, 'runtime-work'), codexHome]) {
    if (await exists(path)) {
      if (!(await fs.lstat(path)).isDirectory())
        throw new Error('Development history directories must not be symbolic links')
    }
  }
  const index = await readJson(join(home, 'runtime-work/index.json'))
  if (
    Object.keys(record(index?.tasks) ?? {}).length ||
    Object.keys(record(index?.workspaces) ?? {}).length
  )
    return true
  const path = join(codexHome, 'state_5.sqlite')
  if (!(await exists(path))) return false
  if (!(await fs.lstat(path)).isFile())
    throw new Error('Development state database must be a regular file')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='threads'").get()) return false
    return Number(db.prepare('SELECT count(*) AS count FROM threads').get()?.count) > 0
  } finally {
    db.close()
  }
}

async function copyRollout(
  sourceCodex: string,
  stageCodex: string,
  targetCodex: string,
  path: string
) {
  // This is the repository's previous Executor Home, not a scan of native/user sessions.
  const legacyCodex = join(dirname(dirname(sourceCodex)), '.wecode/wegent-executor/codex')
  const root = [sourceCodex, legacyCodex].find(root => within(root, path))
  if (!root) throw new Error('A development thread references an unapproved Home')
  const suffix = relative(root, path)
  if (!['sessions', 'archived_sessions'].includes(suffix.split(sep)[0]!)) {
    throw new Error('A development thread references an invalid rollout path')
  }
  const source = join(sourceCodex, suffix)
  await assertRealPath(sourceCodex, source)
  const target = join(stageCodex, suffix)
  const before = await fs.stat(source)
  if (!before.isFile()) throw new Error('Development rollout must be a regular file')
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await fs.copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  await fs.chmod(target, 0o600)
  const after = await fs.stat(source)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error('Development history changed during import; stop its writers and retry')
  }
  return join(targetCodex, suffix)
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

async function copyHistoryDatabase(
  path: string,
  destination: string,
  tables: Set<string>,
  rewrite: (database: DatabaseSync) => Promise<void>
) {
  const source = new DatabaseSync(path, { readOnly: true })
  const target = new DatabaseSync(destination)
  try {
    source.exec('BEGIN')
    target.exec('PRAGMA foreign_keys=OFF')
    target.exec('BEGIN')
    const schema = source
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC"
      )
      .all()
    for (const entry of schema.filter(row => row.type === 'table')) target.exec(String(entry.sql))
    // Do not export device enrollment, credentials or background execution queues.
    for (const entry of schema.filter(
      row => row.type === 'table' && tables.has(String(row.name))
    )) {
      const name = identifier(String(entry.name))
      const columns = source
        .prepare(`PRAGMA table_info(${name})`)
        .all()
        .map(row => String(row.name))
      const insert = target.prepare(
        `INSERT INTO ${name} (${columns.map(identifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      const select = source.prepare(`SELECT * FROM ${name}`)
      select.setReadBigInts(true)
      for (const row of select.iterate()) insert.run(...columns.map(column => row[column]!))
    }
    for (const entry of schema.filter(row => row.type === 'index')) target.exec(String(entry.sql))
    await rewrite(target)
    target.exec('COMMIT')
    source.exec('COMMIT')
    if (target.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') {
      throw new Error('Imported development session database failed integrity verification')
    }
  } finally {
    target.close()
    source.close()
  }
  await fs.chmod(destination, 0o600)
}

async function copyCodexHistory(sourceHome: string, stage: string, targetHome: string) {
  const sourceCodex = join(sourceHome, 'codex')
  const path = join(sourceCodex, 'state_5.sqlite')
  const paths = new Map<string, string>()
  if (!(await exists(path))) return paths
  await assertRealPath(sourceHome, path)
  const stageCodex = join(stage, 'codex')
  await fs.mkdir(stageCodex, { recursive: true, mode: 0o700 })
  await copyHistoryDatabase(
    path,
    join(stageCodex, 'state_5.sqlite'),
    HISTORY_TABLES,
    async target => {
      for (const row of target.prepare('SELECT id, rollout_path FROM threads').all()) {
        const oldPath = String(row.rollout_path)
        const newPath =
          paths.get(oldPath) ??
          (await copyRollout(sourceCodex, stageCodex, join(targetHome, 'codex'), oldPath))
        paths.set(oldPath, newPath)
        target.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(newPath, row.id!)
      }
    }
  )
  const history = join(sourceCodex, 'thread_history_1.sqlite')
  if (await exists(history)) {
    await assertRealPath(sourceHome, history)
    await copyHistoryDatabase(
      history,
      join(stageCodex, 'thread_history_1.sqlite'),
      TURN_HISTORY_TABLES,
      async () => {}
    )
  }
  return paths
}

async function copyRuntimeHistory(
  sourceHome: string,
  stage: string,
  paths: Map<string, string>,
  projectState?: ProjectStateProjector
) {
  for (const path of ['runtime-work/index.json', 'codex/.codex-global-state.json']) {
    if (await exists(join(sourceHome, path)))
      await assertRealPath(sourceHome, join(sourceHome, path))
  }
  const index = await readJson(join(sourceHome, 'runtime-work/index.json'))
  if (index) {
    const tasks = record(index.tasks)
    if (index.version !== 1 || !tasks) {
      throw new Error('Unsupported development runtime history format')
    }
    for (const value of Object.values(tasks)) {
      const task = record(value)
      if (!task) throw new Error('Invalid development task record')
      if (task.runtime !== 'codex')
        throw new Error('Non-Codex development history requires a separate verified import')
      if (task.local_execution)
        throw new Error('Development history still contains an execution; stop it before import')
      const handle = record(task.runtime_handle)
      if (handle?.threadPath) {
        if (typeof handle.threadPath !== 'string' || !paths.has(handle.threadPath))
          throw new Error('Unverified development thread path')
        handle.threadPath = paths.get(handle.threadPath)
      }
      if (handle) {
        delete handle.executionRequest
        delete handle.execution_request
        delete handle.executorSession
      }
    }
    await writeJson(join(stage, 'runtime-work/index.json'), index)
  }
  const sourceState = await readJson(join(sourceHome, 'codex/.codex-global-state.json'))
  const oplog = join(sourceHome, 'runtime-work/.codex-global-state.oplog.jsonl')
  let operations = ''
  if (await exists(oplog)) {
    await assertRealPath(sourceHome, oplog)
    if (!(await fs.lstat(oplog)).isFile())
      throw new Error('Development project operations must be a regular file')
    operations = await fs.readFile(oplog, 'utf8')
  }
  if (sourceState || operations.trim())
    await writeJson(
      join(stage, 'codex/.codex-global-state.json'),
      await replayProjectState(
        Object.fromEntries(
          Object.entries(sourceState ?? {}).filter(([key]) => PROJECT_KEYS.has(key))
        ),
        operations,
        projectState
      )
    )
}

async function sourceSignature(home: string): Promise<string> {
  const files = [
    'runtime-work/index.json',
    'runtime-work/.codex-global-state.oplog.jsonl',
    'codex/.codex-global-state.json',
    'codex/state_5.sqlite',
    'codex/state_5.sqlite-wal',
    'codex/thread_history_1.sqlite',
    'codex/thread_history_1.sqlite-wal',
  ]
  const result = []
  for (const file of files) {
    const path = join(home, file)
    if (!(await exists(path))) {
      result.push([file, null])
      continue
    }
    const stat = await fs.lstat(path, { bigint: true })
    if (!stat.isFile())
      throw new Error('Development history source contains an unexpected link or file type')
    result.push([file, String(stat.ino), String(stat.size), String(stat.mtimeNs)])
  }
  return JSON.stringify(result)
}

export async function migrateDevelopmentHistory(options: HistoryMigrationOptions): Promise<void> {
  const { sourceHome, targetHome } = options
  // Normal startup never reads or imports the old Home. Only an interrupted publication
  // needs recovery before the executor may open its current databases.
  if (!options.importLegacy && !(await hasDevelopmentPublication(targetHome))) return
  if (
    !isAbsolute(sourceHome) ||
    !isAbsolute(targetHome) ||
    sourceHome === targetHome ||
    within(sourceHome, targetHome) ||
    within(targetHome, sourceHome)
  ) {
    throw new Error('Development history requires separate absolute source and target Homes')
  }
  const lock = await options.acquireLock([targetHome])
  try {
    if ((await exists(targetHome)) && !(await fs.lstat(targetHome)).isDirectory()) {
      throw new Error('Development target Home must be a real directory')
    }
    if (await hasDevelopmentPublication(targetHome)) {
      await options.assertIdle(targetHome)
      await recoverDevelopmentPublication(targetHome, () => lock.assertHeld())
    }
    if (!options.importLegacy) return
    const marker = await readJson(join(targetHome, MARKER))
    if (
      marker &&
      (marker.version !== 1 ||
        marker.sourceHome !== sourceHome ||
        marker.targetHome !== targetHome ||
        marker.pending)
    )
      throw new Error(
        'Development history marker does not match this import; refusing to overwrite it'
      )
    if (
      marker?.version === 1 &&
      marker.sourceHome === sourceHome &&
      marker.targetHome === targetHome &&
      !marker.pending &&
      (marker.importedLegacy === true || Number(marker.importedThreads) > 0)
    )
      return
    if (options.previousIsolatedHome) {
      const previous = options.previousIsolatedHome
      if (
        await hasHistory(
          join(previous, 'executor'),
          join(previous, 'workbench/wework/development/codex')
        )
      ) {
        throw new Error(
          'The previous worktree-isolated Home has history; merge it explicitly before switching Homes'
        )
      }
    }
    const legacy = await hasHistory(sourceHome)
    if (!legacy) return
    await options.assertIdle(sourceHome)
    const existingTarget = await exists(targetHome)
    if (existingTarget) await options.assertIdle(targetHome)
    const signature = await sourceSignature(sourceHome)
    const targetSignature = existingTarget ? await sourceSignature(targetHome) : null
    await fs.mkdir(dirname(targetHome), { recursive: true, mode: 0o700 })
    for (const entry of await fs.readdir(dirname(targetHome), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.development-history-')) continue
      const abandoned = join(dirname(targetHome), entry.name)
      const owner = await readJson(join(abandoned, MARKER))
      if (
        owner?.version === 1 &&
        owner.sourceHome === sourceHome &&
        owner.targetHome === targetHome
      ) {
        await fs.rm(abandoned, { recursive: true, force: true })
      }
    }
    const stage = await fs.mkdtemp(join(dirname(targetHome), '.development-history-'))
    await fs.chmod(stage, 0o700)
    try {
      await writeJson(join(stage, MARKER), { version: 1, sourceHome, targetHome, pending: true })
      const paths = await copyCodexHistory(sourceHome, stage, targetHome)
      await copyRuntimeHistory(sourceHome, stage, paths, options.projectState)
      if (existingTarget) {
        await mergeDevelopmentHistory(
          stage,
          targetHome,
          HISTORY_TABLES,
          TURN_HISTORY_TABLES,
          options.projectState
        )
        await options.assertIdle(targetHome)
        if (targetSignature !== (await sourceSignature(targetHome)))
          throw new Error(
            'Development target history changed during import; stop its writers and retry'
          )
      }
      await options.assertIdle(sourceHome)
      if (signature !== (await sourceSignature(sourceHome))) {
        throw new Error('Development history changed during import; stop its writers and retry')
      }
      await fs.writeFile(
        join(stage, MARKER),
        JSON.stringify({
          version: 1,
          sourceHome,
          targetHome,
          importedLegacy: true,
          importedThreads: paths.size,
        }),
        { mode: 0o600 }
      )
      lock.assertHeld()
      if (existingTarget)
        await publishDevelopmentHistory(stage, targetHome, () => lock.assertHeld())
      else {
        if (await exists(targetHome)) throw new Error('Development Home appeared during import')
        await fs.rename(stage, targetHome)
      }
    } catch (error) {
      // Only this attempt's unpublished temporary directory can be removed.
      if (!(await hasDevelopmentPublication(targetHome)))
        await fs.rm(stage, { recursive: true, force: true })
      throw error
    }
  } finally {
    await lock.release()
  }
}

async function assertDevelopmentIdle(home: string): Promise<void> {
  if (process.platform !== 'darwin')
    throw new Error('Legacy development import currently requires macOS')
  const files = [join(home, 'app-ipc.sock'), join(home, 'codex/state_5.sqlite')]
  try {
    const { stdout } = await execute('/usr/sbin/lsof', ['-t', ...files], { timeout: 10_000 })
    if (stdout.trim())
      throw new Error('Stop development instances using the old Home before importing history')
  } catch (error) {
    if ((error as { stdout?: string }).stdout?.trim()) {
      throw new Error('Stop development instances using the old Home before importing history', {
        cause: error,
      })
    }
    if ((error as { code?: unknown }).code === 1 && !(error as { stdout?: string }).stdout?.trim())
      return
    throw error
  }
}

export async function prepareDevelopmentHistory(
  environment: NodeJS.ProcessEnv,
  userData: string,
  home: string
): Promise<void> {
  if (environment.WEWORK_DEVELOPMENT_ISOLATED !== '1') return
  await migrateDevelopmentHistory({
    sourceHome: join(home, '.wework'),
    targetHome: environment.WEGENT_EXECUTOR_HOME!,
    previousIsolatedHome: join(userData, 'runtime-data'),
    importLegacy: environment.WEWORK_IMPORT_LEGACY_DEVELOPMENT_HISTORY === '1',
    acquireLock: executorMigrationLock(environment.WEWORK_EXECUTOR_PATH!),
    assertIdle: assertDevelopmentIdle,
    projectState: executorProjectStateProjector(environment.WEWORK_EXECUTOR_PATH!),
  })
}
