import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createLocalHarnessCliAlias } from '../e2e/desktop/modules/local-harness-cli.mjs'

const directories = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('relocates a Windows npm launcher without introducing a nested batch call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-harness-alias-'))
  directories.push(root)
  const bin = join(root, 'original bin')
  await mkdir(bin)
  const source = join(bin, 'claude.cmd')
  const alias = join(root, 'local-claude.cmd')
  await writeFile(source, '@echo off\r\nSET dp0=%~dp0\r\n"%dp0%\\..\\claude.exe" %*\r\n')

  await createLocalHarnessCliAlias(source, alias, 'win32')

  const launcher = await readFile(alias, 'utf8')
  expect(launcher).toBe(`@echo off\r\nSET dp0=${bin}\\\r\n"${bin}\\\\..\\claude.exe" %*\r\n`)
  expect(launcher).not.toContain(source)
  expect(launcher).not.toMatch(/call\s/i)
  expect(await readFile(source, 'utf8')).toContain('%~dp0')
})

test.runIf(process.platform !== 'win32')(
  'uses the original executable through a Unix symlink',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-harness-alias-'))
    directories.push(root)
    const source = join(root, 'claude')
    const alias = join(root, 'local-claude')
    await writeFile(source, '#!/bin/sh\n')

    await createLocalHarnessCliAlias(source, alias)

    expect(await readlink(alias)).toBe(source)
  }
)
