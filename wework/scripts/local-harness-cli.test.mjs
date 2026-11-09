import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createClaudeCliAlias } from '../e2e/desktop/modules/local-harness-cli.mjs'

const directories = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('links a Windows Claude launcher directly to its native executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-harness-alias-'))
  directories.push(root)
  const bin = join(root, 'node_modules', '.bin')
  const packageRoot = resolve(bin, '../@anthropic-ai/claude-code')
  const native = join(packageRoot, 'bin', 'claude.exe')
  await mkdir(bin, { recursive: true })
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  const source = join(bin, 'claude.cmd')
  const originalLauncher = '@echo off\r\nSET dp0=%~dp0\r\n"%dp0%\\..\\claude.exe" %*\r\n'
  await writeFile(source, originalLauncher)
  await writeFile(native, '')
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ bin: { claude: 'bin/claude.exe' } })
  )

  const alias = await createClaudeCliAlias(bin, root, 'win32')

  expect(alias).toBe(join(root, 'local-claude.cmd'))
  const launcher = await readFile(alias, 'utf8')
  expect(launcher).toBe(`@echo off\r\n"${native}" %*\r\n`)
  expect(launcher).not.toContain(source)
  expect(launcher).not.toMatch(/call\s/i)
  expect(await readFile(source, 'utf8')).toBe(originalLauncher)
})

test.runIf(process.platform !== 'win32')(
  'uses the original executable through a Unix symlink',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-harness-alias-'))
    directories.push(root)
    const bin = join(root, 'bin')
    await mkdir(bin)
    const source = join(bin, 'claude')
    await writeFile(source, '#!/bin/sh\n')

    const alias = await createClaudeCliAlias(bin, root)

    expect(await readlink(alias)).toBe(source)
  }
)
