import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { migrateDevelopmentHistory } from './development-history-migration.js'

let fixture: string
let sourceHome: string
let targetHome: string
const marker = 'migrations/legacy-development-history-v1.json'

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'wework-history-import-'))
  sourceHome = join(fixture, 'home', '.wework')
  targetHome = join(fixture, 'home', '.wegent', 'development', 'workbench', 'wework', 'default')
})
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true })
})

function options() {
  return {
    sourceHome,
    targetHome,
    importLegacy: true,
    assertIdle: vi.fn<(home: string) => Promise<void>>(async () => {}),
    acquireLock: vi.fn(async () => ({ assertHeld() {}, async release() {} })),
  }
}

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function seed() {
  const rollout = join(sourceHome, 'codex/sessions/2026/09/22/synthetic.jsonl')
  const cwd = join(fixture, 'repository with spaces')
  await put(
    rollout,
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1', cwd } }) + '\n'
  )
  const db = new DatabaseSync(join(sourceHome, 'codex/state_5.sqlite'))
  db.exec(`
    CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT);
    CREATE TABLE remote_control_enrollments(secret TEXT);
    CREATE INDEX thread_cwd ON threads(cwd);
    INSERT INTO remote_control_enrollments VALUES ('synthetic-secret');
  `)
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('thread-1', rollout, cwd)
  db.close()
  await put(
    join(sourceHome, 'runtime-work/index.json'),
    JSON.stringify({
      version: 1,
      workspaces: {},
      tasks: {
        'task-1': {
          runtime: 'codex',
          workspace_path: cwd,
          thread_id: 'thread-1',
          runtime_handle: { threadPath: rollout, executionRequest: { token: 'synthetic-secret' } },
        },
      },
    })
  )
  await put(
    join(sourceHome, 'codex/.codex-global-state.json'),
    JSON.stringify({
      'electron-saved-workspace-roots': [cwd],
      'pinned-thread-ids': ['thread-1'],
      unrelatedAccount: 'synthetic-secret',
    })
  )
  await put(join(fixture, 'native-auth.json'), 'synthetic-secret')
  await symlink(join(fixture, 'native-auth.json'), join(sourceHome, 'codex/auth.json'))
  return { rollout, cwd }
}

test('copies history and project state without moving workspaces or sharing credentials', async () => {
  const { rollout, cwd } = await seed()
  const originalIndex = await readFile(join(sourceHome, 'runtime-work/index.json'))
  const originalDatabase = await readFile(join(sourceHome, 'codex/state_5.sqlite'))
  await migrateDevelopmentHistory(options())
  const path = join(targetHome, 'codex/sessions/2026/09/22/synthetic.jsonl')
  expect(await readFile(path, 'utf8')).toBe(await readFile(rollout, 'utf8'))
  const db = new DatabaseSync(join(targetHome, 'codex/state_5.sqlite'), { readOnly: true })
  expect(db.prepare('SELECT rollout_path, cwd FROM threads').get()).toEqual({
    rollout_path: path,
    cwd,
  })
  expect(db.prepare('SELECT count(*) AS n FROM remote_control_enrollments').get()?.n).toBe(0)
  db.close()
  const index = JSON.parse(await readFile(join(targetHome, 'runtime-work/index.json'), 'utf8'))
  expect(index.tasks['task-1'].workspace_path).toBe(cwd)
  expect(index.tasks['task-1'].runtime_handle).toEqual({ threadPath: path })
  expect(
    JSON.parse(await readFile(join(targetHome, 'codex/.codex-global-state.json'), 'utf8'))
  ).toEqual({
    'electron-saved-workspace-roots': [cwd],
    'pinned-thread-ids': ['thread-1'],
  })
  await expect(readFile(join(targetHome, 'codex/auth.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  expect(await readFile(join(sourceHome, 'runtime-work/index.json'))).toEqual(originalIndex)
  expect(await readFile(join(sourceHome, 'codex/state_5.sqlite'))).toEqual(originalDatabase)
  expect(await readFile(join(fixture, 'native-auth.json'), 'utf8')).toBe('synthetic-secret')
})

test('repeated starts do not reimport or overwrite new history', async () => {
  await seed()
  await migrateDevelopmentHistory(options())
  const index = join(targetHome, 'runtime-work/index.json')
  await writeFile(index, 'new-development-history')
  const next = options()
  next.importLegacy = false
  await migrateDevelopmentHistory(next)
  expect(next.assertIdle).not.toHaveBeenCalled()
  expect(await readFile(index, 'utf8')).toBe('new-development-history')
})

test('normal startup ignores legacy history without taking a migration lock or inspecting its occupancy', async () => {
  await seed()
  const normal = { ...options(), importLegacy: false }
  normal.assertIdle.mockRejectedValue(new Error('source active'))
  await migrateDevelopmentHistory(normal)
  expect(normal.acquireLock).not.toHaveBeenCalled()
  expect(normal.assertIdle).not.toHaveBeenCalled()
  await expect(readFile(join(targetHome, marker))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('explicit import requires a stopped source', async () => {
  await seed()
  const active = options()
  active.assertIdle.mockRejectedValue(new Error('source active'))
  await expect(migrateDevelopmentHistory(active)).rejects.toThrow('source active')
  await expect(readFile(join(targetHome, marker))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('preserves unrelated target files and refuses to silently skip previous worktree-isolated tasks', async () => {
  await seed()
  await put(join(targetHome, 'keep.txt'), 'new user data')
  await migrateDevelopmentHistory(options())
  expect(await readFile(join(targetHome, 'keep.txt'), 'utf8')).toBe('new user data')
  const previous = join(fixture, 'previous')
  await put(
    join(previous, 'executor/runtime-work/index.json'),
    JSON.stringify({ tasks: { newer: {} } })
  )
  await expect(
    migrateDevelopmentHistory({
      ...options(),
      targetHome: targetHome + '-separate',
      previousIsolatedHome: previous,
    })
  ).rejects.toThrow('has history')
})

test('repairs only the known earlier Executor prefix against files in the selected source', async () => {
  const { rollout } = await seed()
  const oldPath = join(
    fixture,
    'home/.wecode/wegent-executor/codex/sessions/2026/09/22/synthetic.jsonl'
  )
  const db = new DatabaseSync(join(sourceHome, 'codex/state_5.sqlite'))
  db.prepare('UPDATE threads SET rollout_path = ?').run(oldPath)
  db.close()
  const file = join(sourceHome, 'runtime-work/index.json')
  const index = JSON.parse(await readFile(file, 'utf8'))
  index.tasks['task-1'].runtime_handle.threadPath = oldPath
  await writeFile(file, JSON.stringify(index))
  await migrateDevelopmentHistory(options())
  expect(
    await readFile(join(targetHome, 'codex/sessions/2026/09/22/synthetic.jsonl'), 'utf8')
  ).toBe(await readFile(rollout, 'utf8'))
})

test('rejects foreign session paths instead of scanning another Home', async () => {
  await seed()
  const db = new DatabaseSync(join(sourceHome, 'codex/state_5.sqlite'))
  db.prepare('UPDATE threads SET rollout_path = ?').run(
    join(fixture, 'foreign/sessions/private.jsonl')
  )
  db.close()
  await expect(migrateDevelopmentHistory(options())).rejects.toThrow('unapproved Home')
  await expect(readFile(join(targetHome, marker))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('rejects rollout symlinks escaping the selected source', async () => {
  const { rollout } = await seed()
  await rm(rollout)
  await symlink(join(fixture, 'native-auth.json'), rollout)
  await expect(migrateDevelopmentHistory(options())).rejects.toThrow('outside the selected source')
})

test('failed staging can be retried without publishing partial history', async () => {
  await seed()
  const interrupted = options()
  interrupted.assertIdle
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('writer appeared'))
  await expect(migrateDevelopmentHistory(interrupted)).rejects.toThrow('writer appeared')
  expect(
    (await readdir(dirname(targetHome))).filter(name => name.startsWith('.development-history-'))
  ).toEqual([])
  await migrateDevelopmentHistory(options())
  expect(JSON.parse(await readFile(join(targetHome, marker), 'utf8')).importedThreads).toBe(1)
})

test('recovers owned interrupted staging but retains unknown directories', async () => {
  await seed()
  const owned = join(dirname(targetHome), '.development-history-owned')
  const unknown = join(dirname(targetHome), '.development-history-unknown')
  await put(
    join(owned, marker),
    JSON.stringify({ version: 1, sourceHome, targetHome, pending: true })
  )
  await put(join(unknown, 'keep.txt'), 'not owned')
  await migrateDevelopmentHistory(options())
  expect(await readFile(join(unknown, 'keep.txt'), 'utf8')).toBe('not owned')
  expect((await readdir(dirname(targetHome))).includes('.development-history-owned')).toBe(false)
})

test('fresh normal startup does not create a migration-completed marker', async () => {
  await migrateDevelopmentHistory({ ...options(), importLegacy: false })
  await expect(readFile(join(targetHome, marker))).rejects.toMatchObject({ code: 'ENOENT' })
  await migrateDevelopmentHistory({ ...options(), importLegacy: false })
  await seed()
  await migrateDevelopmentHistory(options())
  expect(JSON.parse(await readFile(join(targetHome, marker), 'utf8')).importedThreads).toBe(1)
})

async function seedCurrent() {
  const rollout = join(targetHome, 'codex/sessions/new.jsonl')
  await put(rollout, 'new synthetic conversation')
  const db = new DatabaseSync(join(targetHome, 'codex/state_5.sqlite'))
  db.exec(`
    CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT);
    CREATE TABLE remote_control_enrollments(secret TEXT);
    CREATE INDEX thread_cwd ON threads(cwd);
    INSERT INTO remote_control_enrollments VALUES ('current-synthetic-enrollment');
  `)
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('thread-2', rollout, fixture)
  db.close()
  await put(
    join(targetHome, 'runtime-work/index.json'),
    JSON.stringify({
      version: 1,
      tasks: { 'task-2': { runtime: 'codex', thread_id: 'thread-2' } },
      workspaces: {},
    })
  )
  await put(
    join(targetHome, 'codex/.codex-global-state.json'),
    JSON.stringify({
      'pinned-thread-ids': ['thread-2'],
      currentSetting: 'keep',
    })
  )
  await put(join(targetHome, 'codex/auth.json'), 'current-synthetic-auth')
}

test('imports after normal use without replacing new tasks, sessions, project state or credentials', async () => {
  await seed()
  await migrateDevelopmentHistory({ ...options(), importLegacy: false })
  await seedCurrent()
  await migrateDevelopmentHistory(options())
  const index = JSON.parse(await readFile(join(targetHome, 'runtime-work/index.json'), 'utf8'))
  expect(Object.keys(index.tasks).sort()).toEqual(['task-1', 'task-2'])
  const db = new DatabaseSync(join(targetHome, 'codex/state_5.sqlite'), { readOnly: true })
  expect(db.prepare('SELECT id FROM threads ORDER BY id').all()).toEqual([
    { id: 'thread-1' },
    { id: 'thread-2' },
  ])
  expect(db.prepare('SELECT secret FROM remote_control_enrollments').get()?.secret).toBe(
    'current-synthetic-enrollment'
  )
  db.close()
  expect(await readFile(join(targetHome, 'codex/sessions/new.jsonl'), 'utf8')).toBe(
    'new synthetic conversation'
  )
  expect(await readFile(join(targetHome, 'codex/auth.json'), 'utf8')).toBe('current-synthetic-auth')
  const state = JSON.parse(
    await readFile(join(targetHome, 'codex/.codex-global-state.json'), 'utf8')
  )
  expect(state['pinned-thread-ids']).toEqual(['thread-2', 'thread-1'])
  expect(state.currentSetting).toBe('keep')
  await migrateDevelopmentHistory(options())
  expect(JSON.parse(await readFile(join(targetHome, 'runtime-work/index.json'), 'utf8'))).toEqual(
    index
  )
})

test('conflicting task IDs fail before changing existing data and normal startup still works', async () => {
  await seed()
  await seedCurrent()
  const path = join(targetHome, 'runtime-work/index.json')
  await writeFile(
    path,
    JSON.stringify({ version: 1, tasks: { 'task-1': { title: 'new' } }, workspaces: {} })
  )
  const before = await readFile(path)
  const database = await readFile(join(targetHome, 'codex/state_5.sqlite'))
  await expect(migrateDevelopmentHistory(options())).rejects.toThrow('ID conflict')
  expect(await readFile(path)).toEqual(before)
  expect(await readFile(join(targetHome, 'codex/state_5.sqlite'))).toEqual(database)
  await migrateDevelopmentHistory({ ...options(), importLegacy: false })
})

test('database conflicts and schema mismatches cannot replace new sessions', async () => {
  await seed()
  await seedCurrent()
  const path = join(targetHome, 'codex/state_5.sqlite')
  const db = new DatabaseSync(path)
  db.exec("UPDATE threads SET id='thread-1'")
  db.close()
  const before = await readFile(path)
  await expect(migrateDevelopmentHistory(options())).rejects.toThrow('ID conflict in threads')
  expect(await readFile(path)).toEqual(before)
  const altered = new DatabaseSync(path)
  altered.exec('ALTER TABLE threads ADD COLUMN new_schema TEXT')
  altered.close()
  await expect(migrateDevelopmentHistory(options())).rejects.toThrow('schema mismatch')
})

test('target writers prevent import without preventing normal startup', async () => {
  await seed()
  await seedCurrent()
  const active = options()
  active.assertIdle.mockImplementation(async home => {
    if (home === targetHome) throw new Error('target active')
  })
  await expect(migrateDevelopmentHistory(active)).rejects.toThrow('target active')
  await migrateDevelopmentHistory({ ...active, importLegacy: false })
})

test('old empty initialization markers do not suppress later explicit import', async () => {
  await seed()
  await put(
    join(targetHome, marker),
    JSON.stringify({ version: 1, sourceHome, targetHome, importedThreads: 0 })
  )
  await migrateDevelopmentHistory(options())
  expect(JSON.parse(await readFile(join(targetHome, marker), 'utf8')).importedLegacy).toBe(true)
})

test('normal startup never opens malformed or unavailable legacy history', async () => {
  await put(join(sourceHome, 'runtime-work/index.json'), 'invalid old JSON')
  await migrateDevelopmentHistory({ ...options(), importLegacy: false })
  await expect(migrateDevelopmentHistory(options())).rejects.toThrow('Cannot parse')
})

test('project replay failures preserve target data and do not prevent normal startup', async () => {
  await seed()
  await seedCurrent()
  const index = await readFile(join(targetHome, 'runtime-work/index.json'))
  await put(
    join(targetHome, 'runtime-work/.codex-global-state.oplog.jsonl'),
    '{"kind":"synthetic pending"}\n'
  )
  await expect(
    migrateDevelopmentHistory({
      ...options(),
      projectState: async () => {
        throw new Error('invalid operation')
      },
    })
  ).rejects.toThrow('invalid operation')
  expect(await readFile(join(targetHome, 'runtime-work/index.json'))).toEqual(index)
  await migrateDevelopmentHistory({ ...options(), importLegacy: false })
})

test('replays legacy operations into the copy, then current operations after merging', async () => {
  await seed()
  await seedCurrent()
  const suffix = 'runtime-work/.codex-global-state.oplog.jsonl'
  const legacyLog = '{"version":1,"kind":"synthetic-legacy"}\n'
  const currentLog = '{"version":1,"kind":"synthetic-current"}\n'
  await put(join(sourceHome, suffix), legacyLog)
  await put(join(targetHome, suffix), currentLog)
  const projectState = vi.fn(async (state: Record<string, unknown>, log: string) => {
    if (log === legacyLog)
      return { ...state, 'local-projects': { legacy: { id: 'legacy', name: 'Legacy project' } } }
    expect(log).toBe(currentLog)
    expect(state['local-projects']).toEqual({ legacy: { id: 'legacy', name: 'Legacy project' } })
    expect(state.currentSetting).toBe('keep')
    return { ...state, 'local-projects': { legacy: { id: 'legacy', name: 'Current rename' } } }
  })
  await migrateDevelopmentHistory({ ...options(), projectState })
  expect(projectState).toHaveBeenCalledTimes(2)
  const state = JSON.parse(
    await readFile(join(targetHome, 'codex/.codex-global-state.json'), 'utf8')
  )
  expect(state['local-projects'].legacy.name).toBe('Current rename')
  expect(await readFile(join(sourceHome, suffix), 'utf8')).toBe(legacyLog)
  expect(await readFile(join(targetHome, suffix), 'utf8')).toBe('')
  await migrateDevelopmentHistory({ ...options(), projectState })
  expect(projectState).toHaveBeenCalledTimes(2)
})

test('legacy operations can establish project state when no state file or target exists', async () => {
  await seed()
  await rm(join(sourceHome, 'codex/.codex-global-state.json'))
  const suffix = 'runtime-work/.codex-global-state.oplog.jsonl'
  await put(join(sourceHome, suffix), 'synthetic pending record')
  const projectState = vi.fn(async () => ({ 'local-projects': { old: { name: 'Restored' } } }))
  await migrateDevelopmentHistory({ ...options(), projectState })
  expect(
    JSON.parse(await readFile(join(targetHome, 'codex/.codex-global-state.json'), 'utf8'))[
      'local-projects'
    ].old.name
  ).toBe('Restored')
  await expect(readFile(join(targetHome, suffix))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(sourceHome, suffix), 'utf8')).toBe('synthetic pending record')
})

test('merged databases retain new records committed to a WAL after a process exits', async () => {
  await seed()
  await seedCurrent()
  const path = join(targetHome, 'codex/state_5.sqlite')
  const crashed = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(process.argv[1])
    db.exec("PRAGMA journal_mode=WAL; INSERT INTO threads VALUES ('thread-3', 'synthetic-new-path', 'synthetic-cwd')")
    process.kill(process.pid, 'SIGKILL')
  `,
      path,
    ],
    { env: { PATH: process.env.PATH, HOME: fixture, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe' }
  )
  expect(crashed.signal, crashed.stderr?.toString()).toBe('SIGKILL')
  expect((await readFile(path + '-wal')).length).toBeGreaterThan(0)
  await migrateDevelopmentHistory(options())
  const db = new DatabaseSync(path, { readOnly: true })
  expect(db.prepare('SELECT id FROM threads ORDER BY id').all()).toEqual([
    { id: 'thread-1' },
    { id: 'thread-2' },
    { id: 'thread-3' },
  ])
  db.close()
})

test('merges native turn history without dropping new message bodies', async () => {
  await seed()
  await seedCurrent()
  for (const [home, id] of [
    [sourceHome, 'thread-1'],
    [targetHome, 'thread-2'],
  ]) {
    const db = new DatabaseSync(join(home!, 'codex/thread_history_1.sqlite'))
    db.exec('CREATE TABLE thread_items(id TEXT PRIMARY KEY, body TEXT)')
    db.prepare('INSERT INTO thread_items VALUES (?, ?)').run(id!, `body-${id}`)
    db.close()
  }
  await migrateDevelopmentHistory(options())
  const db = new DatabaseSync(join(targetHome, 'codex/thread_history_1.sqlite'), { readOnly: true })
  expect(db.prepare('SELECT body FROM thread_items ORDER BY id').all()).toEqual([
    { body: 'body-thread-1' },
    { body: 'body-thread-2' },
  ])
  db.close()
})

test('refuses a source changed by a writer that already exited', async () => {
  await seed()
  const changing = options()
  changing.assertIdle
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      await writeFile(join(sourceHome, 'runtime-work/index.json'), 'changed after copy')
    })
  await expect(migrateDevelopmentHistory(changing)).rejects.toThrow('changed during import')
  await expect(readFile(join(targetHome, marker))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('preserves native turn/item history alongside rollout files', async () => {
  await seed()
  const source = new DatabaseSync(join(sourceHome, 'codex/thread_history_1.sqlite'))
  source.exec(
    "CREATE TABLE thread_items(thread_id TEXT, body TEXT); INSERT INTO thread_items VALUES ('thread-1', 'synthetic assistant reply')"
  )
  source.close()
  await migrateDevelopmentHistory(options())
  const target = new DatabaseSync(join(targetHome, 'codex/thread_history_1.sqlite'), {
    readOnly: true,
  })
  expect(target.prepare('SELECT body FROM thread_items').get()?.body).toBe(
    'synthetic assistant reply'
  )
  target.close()
})
