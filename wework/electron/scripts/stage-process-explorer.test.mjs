import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'

import { stageProcessExplorer } from './stage-process-explorer.mjs'

const roots = []
const execute = promisify(execFile)
const moduleUrl = new URL('./stage-process-explorer.mjs', import.meta.url).href

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stage-process-explorer-'))
  roots.push(root)
  const sourceRoot = join(root, 'source')
  const targetRoot = join(root, 'vendor/process-explorer')
  await mkdir(join(sourceRoot, 'core'), { recursive: true })
  await mkdir(join(sourceRoot, 'host'), { recursive: true })
  await Promise.all([
    writeFile(join(sourceRoot, 'contract.ts'), 'export interface Process { pid: number }\n'),
    writeFile(join(sourceRoot, 'core/snapshot.ts'), 'export const snapshot = []\n'),
    writeFile(join(sourceRoot, 'host/service.ts'), 'export const service = true\n'),
    writeFile(join(sourceRoot, 'core/snapshot.test.ts'), 'excluded test'),
    writeFile(join(sourceRoot, 'host/service.test.tsx'), 'excluded test'),
  ])
  return { sourceRoot, targetRoot }
}

test('concurrent processes publish one complete tree without copying tests', async () => {
  const options = await fixture()
  const script = `
    const { stageProcessExplorer } = await import(${JSON.stringify(moduleUrl)});
    await stageProcessExplorer({ sourceRoot: process.argv[1], targetRoot: process.argv[2] });
  `

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      execute(process.execPath, [
        '--input-type=module',
        '--eval',
        script,
        options.sourceRoot,
        options.targetRoot,
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
