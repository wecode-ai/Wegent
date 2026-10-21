import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test, vi } from 'vitest'

import { stageProcessExplorer } from './stage-process-explorer.mjs'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const filesystem = await vi.importActual('node:fs/promises')
const roots = []
const execute = promisify(execFile)
const moduleUrl = new URL('./stage-process-explorer.mjs', import.meta.url).href

afterEach(async () => {
  vi.mocked(rename).mockImplementation(filesystem.rename)
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stage-process-explorer-'))
  roots.push(root)
  const sourceRoot = join(root, 'source')
  const targetRoot = join(root, 'vendor/process-explorer')
  const stagingRoot = join(root, 'staging')
  await mkdir(join(sourceRoot, 'core'), { recursive: true })
  await mkdir(join(sourceRoot, 'host'), { recursive: true })
  await Promise.all([
    writeFile(join(sourceRoot, 'contract.ts'), 'export interface Process { pid: number }\n'),
    writeFile(join(sourceRoot, 'core/snapshot.ts'), 'export const snapshot = []\n'),
    writeFile(join(sourceRoot, 'host/service.ts'), 'export const service = true\n'),
    writeFile(join(sourceRoot, 'core/snapshot.test.ts'), 'excluded test'),
    writeFile(join(sourceRoot, 'host/service.test.tsx'), 'excluded test'),
  ])
  return { sourceRoot, targetRoot, stagingRoot }
}

test('plain Node processes publish one complete tree without a TypeScript loader', async () => {
  const options = await fixture()
  const script = `
    const { stageProcessExplorer } = await import(${JSON.stringify(moduleUrl)});
    await stageProcessExplorer({ sourceRoot: process.argv[1], targetRoot: process.argv[2], stagingRoot: process.argv[3] });
  `

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      execute(process.execPath, [
        ...(process.allowedNodeEnvironmentFlags.has('--no-experimental-strip-types')
          ? ['--no-experimental-strip-types']
          : []),
        '--input-type=module',
        '--eval',
        script,
        options.sourceRoot,
        options.targetRoot,
        options.stagingRoot,
      ])
    )
  )

  for (const result of results) {
    expect(result.status, result.reason?.message).toBe('fulfilled')
  }
  expect((await readdir(options.targetRoot)).sort()).toEqual(['contract.ts', 'core', 'host'])
  expect(await readdir(join(options.targetRoot, 'core'))).toEqual(['snapshot.ts'])
  expect(await readdir(join(options.targetRoot, 'host'))).toEqual(['service.ts'])
  expect(await readFile(join(options.targetRoot, 'contract.ts'), 'utf8')).toBe(
    'export interface Process { pid: number }\n'
  )
})

test('unchanged staging preserves files already being consumed by another check', async () => {
  const options = await fixture()
  await stageProcessExplorer(options)
  const file = join(options.targetRoot, 'core/snapshot.ts')
  const before = await stat(file, { bigint: true })

  await stageProcessExplorer(options)

  const after = await stat(file, { bigint: true })
  expect(after.ino).toBe(before.ino)
  expect(after.mtimeNs).toBe(before.mtimeNs)
  expect(await readFile(file, 'utf8')).toBe('export const snapshot = []\n')
})

test('changed sources replace obsolete files and repair incomplete output', async () => {
  const options = await fixture()
  await stageProcessExplorer(options)
  await writeFile(join(options.sourceRoot, 'core/snapshot.ts'), 'export const snapshot = [1]\n')
  await rm(join(options.sourceRoot, 'host/service.ts'))

  await stageProcessExplorer(options)

  expect(await readFile(join(options.targetRoot, 'core/snapshot.ts'), 'utf8')).toBe(
    'export const snapshot = [1]\n'
  )
  expect(await readdir(join(options.targetRoot, 'host'))).toEqual([])
  await rm(join(options.targetRoot, 'core/snapshot.ts'))
  await stageProcessExplorer(options)
  expect(await readFile(join(options.targetRoot, 'core/snapshot.ts'), 'utf8')).toBe(
    'export const snapshot = [1]\n'
  )
})

test('failed staging preserves published files and releases its lock', async () => {
  const options = await fixture()
  await stageProcessExplorer(options)
  await rm(join(options.sourceRoot, 'contract.ts'))

  await expect(stageProcessExplorer(options)).rejects.toMatchObject({ code: 'ENOENT' })

  expect(await readFile(join(options.targetRoot, 'contract.ts'), 'utf8')).toBe(
    'export interface Process { pid: number }\n'
  )
  await expect(stat(`${options.targetRoot}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(join(options.sourceRoot, 'contract.ts'), 'export interface Process {}\n')
  await stageProcessExplorer(options)
  expect(await readFile(join(options.targetRoot, 'contract.ts'), 'utf8')).toBe(
    'export interface Process {}\n'
  )
})

test('failed publication restores the complete previous tree and releases its lock', async () => {
  const options = await fixture()
  await stageProcessExplorer(options)
  const before = await stat(options.targetRoot, { bigint: true })
  await writeFile(join(options.sourceRoot, 'core/snapshot.ts'), 'updated source\n')
  const failure = Object.assign(new Error('publication failed'), { code: 'EACCES' })
  vi.mocked(rename).mockImplementation(async (source, target) => {
    if (source.startsWith(join(options.stagingRoot, 'prepared-'))) throw failure
    return filesystem.rename(source, target)
  })

  await expect(stageProcessExplorer(options)).rejects.toBe(failure)

  expect((await stat(options.targetRoot, { bigint: true })).ino).toBe(before.ino)
  expect(await readFile(join(options.targetRoot, 'core/snapshot.ts'), 'utf8')).toBe(
    'export const snapshot = []\n'
  )
  expect((await readdir(options.targetRoot)).sort()).toEqual(['contract.ts', 'core', 'host'])
  expect(await readdir(options.stagingRoot)).toEqual([])
  await expect(stat(`${options.targetRoot}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('interrupted publication is restored before a subsequent source-copy failure', async () => {
  const options = await fixture()
  await stageProcessExplorer(options)
  const before = await stat(options.targetRoot, { bigint: true })
  await writeFile(join(options.sourceRoot, 'core/snapshot.ts'), 'updated source\n')
  vi.mocked(rename).mockImplementation(async (source, target) => {
    if (target === options.targetRoot) throw new Error('interrupted publication')
    return filesystem.rename(source, target)
  })
  await expect(stageProcessExplorer(options)).rejects.toBeInstanceOf(AggregateError)
  await expect(stat(options.targetRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  vi.mocked(rename).mockImplementation(filesystem.rename)
  await rm(join(options.sourceRoot, 'contract.ts'))

  await expect(stageProcessExplorer(options)).rejects.toMatchObject({ code: 'ENOENT' })

  expect((await stat(options.targetRoot, { bigint: true })).ino).toBe(before.ino)
  expect(await readFile(join(options.targetRoot, 'core/snapshot.ts'), 'utf8')).toBe(
    'export const snapshot = []\n'
  )
  expect(await readdir(options.stagingRoot)).toEqual([])
})

test('a completed publication keeps its new tree when an old backup remains', async () => {
  const options = await fixture()
  await stageProcessExplorer(options)
  await writeFile(join(options.sourceRoot, 'core/snapshot.ts'), 'updated source\n')
  await stageProcessExplorer(options)
  const backup = vi.mocked(rename).mock.calls.find(([source]) => source === options.targetRoot)[1]
  await mkdir(backup)
  await writeFile(join(backup, 'obsolete.ts'), 'old sources')
  const before = await stat(options.targetRoot, { bigint: true })

  await stageProcessExplorer(options)

  expect((await stat(options.targetRoot, { bigint: true })).ino).toBe(before.ino)
  expect(await readFile(join(options.targetRoot, 'core/snapshot.ts'), 'utf8')).toBe(
    'updated source\n'
  )
  expect(await readdir(options.stagingRoot)).toEqual([])
})
