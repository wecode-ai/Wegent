import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterEach, expect, test } from 'vitest'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'migration-worker-')))
  roots.push(root)
  // Emit only these isolated modules, using the same ESM worker entry as Electron.
  // No application profile, credentials, or existing task database is opened.
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  for (const name of [
    'workbench-data-worker',
    'workbench-executor-data',
    'workbench-data-migration',
  ]) {
    const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8')
    const result = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    })
    await writeFile(join(root, `${name}.js`), result.outputText)
  }
  const { migrateWorkbenchDataInWorker } = await import(
    pathToFileURL(join(root, 'workbench-data-worker.js')).href
  )
  const source = join(root, 'old')
  const target = join(root, 'new')
  const state = join(target, 'migrations')
  mkdirSync(join(source, 'data'), { recursive: true })
  return {
    source,
    target,
    state,
    migrate: () => migrateWorkbenchDataInWorker({ source, target, state }) as Promise<void>,
  }
}

test('large history migrates without blocking the parent event loop and restarts without rescanning attachments', async () => {
  const { source, target, state, migrate } = await fixture()
  writeFileSync(join(source, 'device-config.json'), '{}')
  const db = new DatabaseSync(join(source, 'data/tasks.sqlite'))
  db.exec('CREATE TABLE tasks(id INTEGER PRIMARY KEY, title TEXT); BEGIN')
  const insert = db.prepare('INSERT INTO tasks VALUES (?, ?)')
  for (let id = 0; id < 20_000; id++) insert.run(id, `Synthetic task ${id}`)
  db.exec('COMMIT')
  db.close()
  for (let id = 0; id < 1_000; id++) {
    const directory = join(source, 'data/objects/attachments', String(id))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'attachment.txt'), 'synthetic attachment')
  }
  let responsiveDuringMigration = 0
  const timer = setInterval(() => {
    if (
      existsSync(join(target, 'device-config.json')) &&
      !existsSync(join(state, 'task-database-verified-v1'))
    )
      responsiveDuringMigration++
  }, 1)
  try {
    await migrate()
  } finally {
    clearInterval(timer)
  }
  expect(responsiveDuringMigration).toBeGreaterThan(0)
  const migrated = new DatabaseSync(join(target, 'data/tasks.sqlite'), { readOnly: true })
  try {
    expect(migrated.prepare('SELECT count(*) AS total FROM tasks').get()?.total).toBe(20_000)
  } finally {
    migrated.close()
  }
  const oldAttachment = join(source, 'data/objects/attachments/999/attachment.txt')
  expect(realpathSync(join(target, 'data/objects/attachments/999/attachment.txt'))).toBe(
    oldAttachment
  )
  // A completed restart must not enumerate old attachment trees again.
  // Removing the synthetic files also makes any unintended traversal observable.
  await rm(join(source, 'data/objects/attachments'), { recursive: true })
  await migrate()
})

test('worker failure rejects startup and leaves conflicting data intact', async () => {
  const { source, target, migrate } = await fixture()
  writeFileSync(join(source, 'device-config.json'), 'old')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'device-config.json'), 'new')
  await expect(migrate()).rejects.toThrow('conflict')
  expect(readFileSync(join(source, 'device-config.json'), 'utf8')).toBe('old')
  expect(readFileSync(join(target, 'device-config.json'), 'utf8')).toBe('new')
})
