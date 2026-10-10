import * as fs from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { migrateWorkbenchDataEntry } from './workbench-data-migration.js'

function exists(path: string): boolean {
  try {
    fs.lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

// Persist the inventory before moving entries so a crash between rename and
// bridge publication cannot hide a missing source from the next startup.
function migrateChildren(source: string, target: string, state: string, excluded: string[]): void {
  fs.mkdirSync(source, { recursive: true, mode: 0o700 })
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  const manifest = join(state, 'entries.json')
  let names: string[]
  if (exists(manifest)) {
    names = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    if (
      !Array.isArray(names) ||
      names.some(
        name =>
          typeof name !== 'string' ||
          !name ||
          name === '.' ||
          name === '..' ||
          /[/\\]/.test(name) ||
          excluded.includes(name)
      )
    ) {
      throw new Error('Invalid executor data migration inventory')
    }
  } else {
    names = fs
      .readdirSync(source, { withFileTypes: true })
      .filter(
        entry =>
          !excluded.includes(entry.name) &&
          !entry.name.startsWith('.wework-home-migration-') &&
          !entry.isSocket() &&
          !entry.isFIFO()
      )
      .map(entry => entry.name)
      .sort()
    const temporary = `${manifest}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(names), { mode: 0o600 })
    fs.renameSync(temporary, manifest)
  }
  for (const name of names) {
    migrateWorkbenchDataEntry({
      source: join(source, name),
      target: join(target, name),
      journal: join(state, `${Buffer.from(name).toString('hex')}.json`),
    })
  }
}

export function migrateWorkbenchExecutorData(source: string, target: string, state: string): void {
  migrateChildren(source, target, join(state, 'executor-data-v1'), [
    'codex',
    'claude',
    'capabilities',
    'workspace',
    'attachments',
    'worktrees',
    'data',
    // The unbranded legacy root also contains other branded applications.
    'apps',
  ])
  // Keep old workspace paths as aliases while only the historical task artifacts
  // remain physically in place. New attachments/worktrees use the new workspace.
  migrateChildren(
    join(source, 'workspace'),
    join(target, 'workspace'),
    join(state, 'executor-workspace-v1'),
    ['attachments', 'worktrees']
  )
  migrateChildren(join(source, 'data'), join(target, 'data'), join(state, 'task-data-v1'), [
    'objects',
    'cache',
  ])
  migrateChildren(
    join(source, 'data/objects'),
    join(target, 'data/objects'),
    join(state, 'task-objects-v1'),
    ['attachments']
  )
  migrateChildren(
    join(source, 'data/cache'),
    join(target, 'data/cache'),
    join(state, 'task-cache-v1'),
    ['gitlab-attachments']
  )
  for (const path of [
    'attachments',
    'worktrees',
    'workspace/attachments',
    'workspace/worktrees',
    'data/objects/attachments',
    'data/cache/gitlab-attachments',
  ]) {
    const marker = join(state, `retained-${Buffer.from(path).toString('hex')}-v1`)
    if (!exists(marker)) {
      retainChildren(join(source, path), join(target, path), !path.endsWith('worktrees'))
      fs.writeFileSync(marker, '1\n', { flag: 'wx', mode: 0o600 })
    }
  }
  const database = join(target, 'data/tasks.sqlite')
  const verified = join(state, 'task-database-verified-v1')
  if (exists(database) && !exists(verified)) {
    const db = new DatabaseSync(database, { readOnly: true })
    try {
      const rows = db.prepare('PRAGMA quick_check').all()
      if (rows.length !== 1 || rows[0].quick_check !== 'ok')
        throw new Error('Migrated task database failed integrity verification')
    } finally {
      db.close()
    }
    fs.writeFileSync(verified, '1\n', { flag: 'wx', mode: 0o600 })
  }
}

function retainChildren(source: string, target: string, recurse: boolean): void {
  if (!exists(source)) return
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  for (const name of fs.readdirSync(source)) {
    const oldEntry = join(source, name)
    const newEntry = join(target, name)
    // Do not alias grouping directories such as draft/ or runtime/: doing so
    // would route every future upload back into the legacy Home.
    if (recurse && fs.lstatSync(oldEntry).isDirectory()) {
      if (exists(newEntry) && !fs.lstatSync(newEntry).isDirectory())
        throw new Error(`Historical attachment directory conflict: ${newEntry}`)
      retainChildren(oldEntry, newEntry, true)
      continue
    }
    if (exists(newEntry)) {
      if (fs.realpathSync(newEntry) !== fs.realpathSync(oldEntry))
        throw new Error(`Historical artifact path conflict: ${newEntry}`)
    } else {
      fs.symlinkSync(oldEntry, newEntry, fs.statSync(oldEntry).isDirectory() ? 'junction' : 'file')
    }
  }
}
