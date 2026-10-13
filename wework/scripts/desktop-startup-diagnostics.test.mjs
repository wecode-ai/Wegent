import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
  collectCodexSqliteHealth,
  observeDesktopAppProcess,
} from '../e2e/desktop/modules/desktop-startup-diagnostics.mjs'

test('captures lifecycle status without command, environment, or error message contents', () => {
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null })
  const state = observeDesktopAppProcess(child)
  child.emit('error', Object.assign(new Error('private launch arguments'), { code: 'ENOENT' }))
  child.emit('exit', 1, null)
  expect(state).toEqual({
    pid: 42,
    exitCode: 1,
    signal: null,
    spawnError: { code: 'ENOENT', sqliteCode: null },
  })
})

test('reads database health and migrations without exposing private rows or changing state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-sqlite-diagnostics-'))
  try {
    const path = join(root, 'state_5.sqlite')
    const database = new DatabaseSync(path)
    database.exec(
      "CREATE TABLE _sqlx_migrations(version INTEGER, success INTEGER); INSERT INTO _sqlx_migrations VALUES (3, 1); CREATE TABLE threads(secret TEXT); INSERT INTO threads VALUES ('private conversation'); PRAGMA user_version = 7"
    )
    database.close()
    await writeFile(join(root, 'auth.json'), 'private credentials')
    await writeFile(join(root, 'queue_1.sqlite'), 'invalid database')
    const linkedDirectory = join(root, 'linked-directory')
    await mkdir(linkedDirectory)
    await symlink(
      linkedDirectory,
      join(root, 'logs_2.sqlite'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const before = await readFile(path)

    const health = await collectCodexSqliteHealth(root)

    expect(health.files.find(file => file.name === 'state_5.sqlite')).toMatchObject({
      regularFile: true,
      quickCheck: { passed: true, issueCount: 0 },
      userVersion: 7,
      migrations: [{ version: 3, success: 1 }],
    })
    expect(health.files.find(file => file.name === 'queue_1.sqlite').error).toBeDefined()
    expect(health.files.find(file => file.name === 'logs_2.sqlite')).toMatchObject({
      regularFile: false,
    })
    expect(JSON.stringify(health)).not.toMatch(/private|credentials|conversation|secret/)
    expect(JSON.stringify(health)).not.toContain(root)
    expect(await readFile(path)).toEqual(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('inspects a WAL snapshot without creating or changing application sidecar files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-sqlite-diagnostics-'))
  let database
  try {
    database = new DatabaseSync(join(root, 'state_5.sqlite'))
    database.exec('PRAGMA journal_mode = WAL; CREATE TABLE private_rows(value TEXT)')
    database.exec("INSERT INTO private_rows VALUES ('never collect conversation data')")
    const names = (await readdir(root)).sort()
    const before = await Promise.all(names.map(name => readFile(join(root, name))))

    const result = await collectCodexSqliteHealth(root)

    expect(result.files[0]).toMatchObject({
      snapshotChecks: true,
      quickCheck: { passed: true, issueCount: 0 },
    })
    expect((await readdir(root)).sort()).toEqual(names)
    expect(await Promise.all(names.map(name => readFile(join(root, name))))).toEqual(before)
    expect(JSON.stringify(result)).not.toMatch(/never collect|conversation data|private_rows/)
  } finally {
    database?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('does not create missing directories or missing databases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-sqlite-diagnostics-'))
  try {
    const missing = join(root, 'absent')
    expect(await collectCodexSqliteHealth(missing)).toEqual({
      directoryError: { code: 'ENOENT', sqliteCode: null },
      files: [],
    })
    expect(await collectCodexSqliteHealth(root)).toEqual({ files: [] })
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
