// @vitest-environment node

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  dependencyPaths,
  preReadFiles,
  preReadBrowserRuntime,
  runtimeFiles,
} from '../e2e/desktop/modules/external-browser-preread.mjs'

test('does not read any runtime files unless the CI experiment is explicitly enabled', async () => {
  expect(await preReadBrowserRuntime(false)).toBeNull()
})

test('CI pre-read runs immediately before creating the isolated browser profile', async () => {
  const source = await readFile(
    new URL('../e2e/desktop/modules/external-browser-fixture.mjs', import.meta.url),
    'utf8'
  )
  const preparation = source.indexOf('await preReadBrowserRuntime(')
  expect(preparation).toBeGreaterThan(0)
  expect(preparation).toBeLessThan(source.indexOf('await mkdtemp('))
  expect(source).toContain("process.env.WEWORK_E2E_EXTERNAL_BROWSER_PREREAD === '1'")
})

test('collects existing runtime files without following links outside the runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-preread-'))
  try {
    const runtime = join(root, 'runtime')
    await mkdir(join(runtime, 'resources'), { recursive: true })
    await writeFile(join(runtime, 'chrome'), 'program')
    await writeFile(join(runtime, 'resources', 'data.pak'), 'resources')
    await mkdir(join(root, 'unrelated'))
    await writeFile(join(root, 'unrelated', 'private'), 'not part of the runtime')
    await symlink(
      join(root, 'unrelated'),
      join(runtime, 'outside-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(await runtimeFiles(runtime)).toEqual([
      join(runtime, 'chrome'),
      join(runtime, 'resources', 'data.pak'),
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves only absolute dynamic dependencies and rejects missing libraries', () => {
  expect(
    dependencyPaths(
      [
        'linux-vdso.so.1 (0x00007ffff)',
        'libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x0000711)',
        '/lib64/ld-linux-x86-64.so.2 (0x0000712)',
      ].join('\n')
    )
  ).toEqual(['/lib/x86_64-linux-gnu/libc.so.6', '/lib64/ld-linux-x86-64.so.2'])
  expect(() => dependencyPaths('libmissing.so => not found')).toThrow('dependency is missing')
})

test('reads each original file once without changing its contents, identity or mtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-preread-'))
  try {
    const binary = join(root, 'chrome')
    const dependency = join(root, 'libc.so')
    await writeFile(binary, Buffer.alloc(1024 * 1024 + 17, 42))
    await writeFile(dependency, 'dependency')
    const before = await stat(binary)
    const digest = async () =>
      createHash('sha256')
        .update(await readFile(binary))
        .digest('hex')
    const hash = await digest()
    const result = await preReadFiles([binary, dependency, binary])
    expect(result.files).toBe(2)
    expect(result.bytes).toBe(before.size + 10)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    const after = await stat(binary)
    expect([after.ino, after.size, after.mtimeMs]).toEqual([
      before.ino,
      before.size,
      before.mtimeMs,
    ])
    expect(await digest()).toBe(hash)
    await expect(preReadFiles([join(root, 'missing')])).rejects.toThrow()
    await expect(preReadFiles([root])).rejects.toThrow('regular file')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
