import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  HISTORY_MARKER,
  publishDevelopmentHistory,
  recoverDevelopmentPublication,
} from './development-history-merge.js'
import { migrateDevelopmentHistory } from './development-history-migration.js'

let root: string
let stage: string
let target: string

async function put(path: string, value: string) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, value)
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'wework-history-publication-'))
  target = join(root, 'target')
  stage = await fs.mkdtemp(join(root, '.development-history-'))
  await put(join(target, 'runtime-work/index.json'), 'current')
  await put(join(stage, 'runtime-work/index.json'), 'merged')
  await put(join(stage, HISTORY_MARKER), 'completed')
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('publication failure rolls back before the completed marker and retry succeeds', async () => {
  let calls = 0
  await expect(
    publishDevelopmentHistory(stage, target, () => {
      if (++calls === 2) throw new Error('lock lost')
    })
  ).rejects.toThrow('lock lost')
  expect(await fs.readFile(join(target, 'runtime-work/index.json'), 'utf8')).toBe('current')
  await expect(fs.stat(join(target, HISTORY_MARKER))).rejects.toMatchObject({ code: 'ENOENT' })
  await put(join(stage, 'runtime-work/index.json'), 'merged')
  await put(join(stage, HISTORY_MARKER), 'completed')
  await publishDevelopmentHistory(stage, target, () => {})
  expect(await fs.readFile(join(target, 'runtime-work/index.json'), 'utf8')).toBe('merged')
})

async function identity(path: string) {
  const value = await fs.stat(path, { bigint: true })
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}`
}

async function interruptPublication() {
  const path = 'runtime-work/index.json'
  const entries = [
    { path, before: await identity(join(target, path)), after: await identity(join(stage, path)) },
    { path: HISTORY_MARKER, before: null, after: await identity(join(stage, HISTORY_MARKER)) },
  ]
  await put(
    join(root, '.development-history-publication.json'),
    JSON.stringify({ version: 1, target, stage, entries })
  )
  await fs.mkdir(join(stage, '.rollback/runtime-work'), { recursive: true })
  await fs.rename(join(target, path), join(stage, '.rollback', path))
  await fs.rename(join(stage, path), join(target, path))
}

test('normal startup recovers an interrupted import without reading old history', async () => {
  await interruptPublication()
  await migrateDevelopmentHistory({
    sourceHome: join(root, 'absent-source'),
    targetHome: target,
    importLegacy: false,
    assertIdle: async () => {},
    acquireLock: async () => ({ assertHeld() {}, async release() {} }),
  })
  expect(await fs.readFile(join(target, 'runtime-work/index.json'), 'utf8')).toBe('current')
  await expect(fs.stat(join(root, '.development-history-publication.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

test('interruption after committing the marker retains the published files', async () => {
  await interruptPublication()
  await fs.mkdir(dirname(join(target, HISTORY_MARKER)), { recursive: true })
  await fs.rename(join(stage, HISTORY_MARKER), join(target, HISTORY_MARKER))
  await recoverDevelopmentPublication(target, () => {})
  expect(await fs.readFile(join(target, 'runtime-work/index.json'), 'utf8')).toBe('merged')
})

test('recovery refuses files changed by another writer and retains its backup', async () => {
  await interruptPublication()
  await fs.writeFile(join(target, 'runtime-work/index.json'), 'another writer')
  await expect(recoverDevelopmentPublication(target, () => {})).rejects.toThrow(
    'refusing to overwrite'
  )
  expect(await fs.readFile(join(target, 'runtime-work/index.json'), 'utf8')).toBe('another writer')
  expect(await fs.readFile(join(stage, '.rollback/runtime-work/index.json'), 'utf8')).toBe(
    'current'
  )
})

test('publication does not follow target parent symlinks', async () => {
  const external = join(root, 'external')
  await fs.rename(join(target, 'runtime-work'), external)
  await fs.symlink(external, join(target, 'runtime-work'))
  await expect(publishDevelopmentHistory(stage, target, () => {})).rejects.toThrow(
    'not a real directory'
  )
  expect(await fs.readFile(join(external, 'index.json'), 'utf8')).toBe('current')
})
