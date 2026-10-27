import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'

import { stageProcessExplorer } from './stage-process-explorer.mjs'

const directories = []
const script = fileURLToPath(new URL('./stage-process-explorer.mjs', import.meta.url))
const exec = promisify(execFile)
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-stage-process-'))
  directories.push(root)
  const sourceRoot = join(root, 'source')
  const targetRoot = join(root, 'vendor', 'process-explorer')
  await mkdir(join(sourceRoot, 'core'), { recursive: true })
  await mkdir(join(sourceRoot, 'host'))
  await writeFile(join(sourceRoot, 'contract.ts'), 'export const protocol = 1\n')
  await writeFile(join(sourceRoot, 'core', 'index.ts'), 'export const core = true\n')
  await writeFile(join(sourceRoot, 'core', 'index.test.ts'), 'ignored test')
  await writeFile(join(sourceRoot, 'host', 'index.ts'), 'export const host = true\n')
  return { sourceRoot, targetRoot }
}

test('two real processes can cold-stage the same source without colliding', async () => {
  const { sourceRoot, targetRoot } = await fixture()
  await Promise.all([
    exec(process.execPath, [script, sourceRoot, targetRoot]),
    exec(process.execPath, [script, sourceRoot, targetRoot]),
  ])
  expect(await readFile(join(targetRoot, 'core/index.ts'), 'utf8')).toBe(
    'export const core = true\n'
  )
  await expect(stat(join(targetRoot, 'core/index.test.ts'))).rejects.toThrow('ENOENT')
})

test('another staging process leaves unchanged sources intact while a real reader uses them', async () => {
  const options = await fixture()
  await stageProcessExplorer(options)
  const file = join(options.targetRoot, 'core/index.ts')
  const before = await stat(file)
  const reader = `
    const { readFile, stat } = await import('node:fs/promises')
    const path = process.argv[1]
    const before = await stat(path)
    for (let index = 0; index < 500; index++) {
      await readFile(path)
      const after = await stat(path)
      if (after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) throw new Error('Staged source was replaced')
    }
  `
  await Promise.all([
    exec(process.execPath, ['--input-type=module', '-e', reader, file]),
    exec(process.execPath, [script, options.sourceRoot, options.targetRoot]),
  ])
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
})

test('source changes publish a complete replacement while test-only edits reuse the staged tree', async () => {
  const options = await fixture()
  await stageProcessExplorer(options)
  const before = await readFile(join(options.targetRoot, '.source-sha256'), 'utf8')
  await writeFile(join(options.sourceRoot, 'core/index.test.ts'), 'changed ignored test')
  await stageProcessExplorer(options)
  expect(await readFile(join(options.targetRoot, '.source-sha256'), 'utf8')).toBe(before)
  await writeFile(join(options.sourceRoot, 'core/index.ts'), 'export const core = 2\n')
  await stageProcessExplorer(options)
  expect(await readFile(join(options.targetRoot, 'core/index.ts'), 'utf8')).toBe(
    'export const core = 2\n'
  )
  expect(await readFile(join(options.targetRoot, '.source-sha256'), 'utf8')).not.toBe(before)
})
