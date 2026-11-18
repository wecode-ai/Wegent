// @vitest-environment node

import { access, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { pruneHarnessRuntime } from './harness-runtime-pruning.mjs'
import { assertPortableHarnessRuntime } from './portable-runtime.mjs'

const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('pruneHarnessRuntime', () => {
  test('keeps only macOS arm64 native payloads and runtime JavaScript', async () => {
    const root = await runtimeFixture()
    await pruneHarnessRuntime(root, 'macos-arm64')

    await expectExists(join(root, 'node-pty', 'prebuilds', 'darwin-arm64', 'pty.node'))
    await expectMissing(join(root, 'node-pty', 'prebuilds', 'darwin-x64'))
    await expectMissing(join(root, 'node-pty', 'prebuilds', 'win32-x64'))
    await expectMissing(join(root, 'node-pty', 'third_party'))
    await expectExists(join(root, '@reflink', 'reflink', 'index.js'))
    await expectExists(join(root, '@reflink', 'reflink-darwin-arm64', 'reflink.node'))
    await expectMissing(join(root, '@reflink', 'reflink-darwin-x64'))
    await expectMissing(join(root, 'package', 'index.js.map'))
    await expectMissing(join(root, 'package', 'index.d.ts'))
    await expectExists(join(root, 'package', 'index.js'))
    await expectMissing(join(root, 'node_modules', '.modules.yaml'))
    await expectMissing(join(root, 'node_modules', '.pnpm-workspace-state-v1.json'))
  })

  test('removes unsupported reflink native packages for Linux', async () => {
    const root = await runtimeFixture()
    await pruneHarnessRuntime(root, 'linux-x64')

    await expectExists(join(root, 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'))
    await expectMissing(join(root, '@reflink', 'reflink-darwin-arm64'))
    await expectMissing(join(root, '@reflink', 'reflink-win32-x64-msvc'))
    await expectExists(join(root, '@reflink', 'reflink', 'index.js'))
  })

  test('keeps only Windows arm64 native payloads', async () => {
    const root = await runtimeFixture()
    await pruneHarnessRuntime(root, 'windows-arm64')

    await expectExists(join(root, 'node-pty', 'prebuilds', 'win32-arm64', 'pty.node'))
    await expectMissing(join(root, 'node-pty', 'prebuilds', 'win32-x64'))
    await expectMissing(join(root, 'node-pty', 'prebuilds', 'darwin-arm64'))
    await expectExists(join(root, '@reflink', 'reflink-win32-arm64-msvc', 'reflink.node'))
    await expectMissing(join(root, '@reflink', 'reflink-win32-x64-msvc'))
  })

  test('removes dangling dependency links left by partial installs', async () => {
    const root = await runtimeFixture()
    const packageDependencies = join(root, 'node_modules', '.pnpm', 'package@1.0.0', 'node_modules')
    await mkdir(join(packageDependencies, 'package'), { recursive: true })
    await writeFile(
      join(packageDependencies, 'package', 'package.json'),
      JSON.stringify({ optionalDependencies: { 'missing-optional': '1.0.0' } })
    )
    await symlink('../missing-optional', join(packageDependencies, 'missing-optional'))
    await symlink(
      join('.pnpm', 'package@1.0.0', 'node_modules', 'package'),
      join(root, 'node_modules', 'package')
    )

    await pruneHarnessRuntime(root, 'macos-arm64')

    await expectLinkMissing(join(packageDependencies, 'missing-optional'))
    await expectExists(join(root, 'node_modules', 'package'))
  })

  test('removes dependency links whose target is pruned', async () => {
    const root = await runtimeFixture()
    const packageDependencies = join(root, 'node_modules', '.pnpm', 'package@1.0.0', 'node_modules')
    await mkdir(join(packageDependencies, 'optional-package'), { recursive: true })
    await symlink('optional-package', join(packageDependencies, 'present-optional'))
    await symlink('../../../../package/index.d.ts', join(packageDependencies, 'pruned-optional'))
    await expectExists(join(packageDependencies, 'pruned-optional'))

    await pruneHarnessRuntime(root, 'macos-arm64')

    await expectLinkMissing(join(packageDependencies, 'pruned-optional'))
    await expectExists(join(packageDependencies, 'present-optional'))
  })

  test('rejects a broken required entry instead of packaging an incomplete runtime', async () => {
    const root = await runtimeFixture()
    await mkdir(join(root, 'node_modules', '@deepseek-ai'))
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.2.0-rc.2' } })
    )
    const link = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    await symlink('../missing-dsh', link)

    await expect(pruneHarnessRuntime(root, 'macos-arm64')).rejects.toThrow('broken symlink')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    await expect(assertPortableHarnessRuntime(root)).rejects.toThrow('broken symlink')
  })

  test('retains a missing shared dependency when another package requires it', async () => {
    const root = await runtimeFixture()
    const modules = join(root, 'node_modules')
    for (const name of ['optional-owner', 'required-owner']) await mkdir(join(modules, name))
    await writeFile(
      join(modules, 'optional-owner', 'package.json'),
      JSON.stringify({ optionalDependencies: { shared: '1.0.0' } })
    )
    await writeFile(
      join(modules, 'required-owner', 'package.json'),
      JSON.stringify({ dependencies: { shared: '1.0.0' } })
    )
    await symlink('missing', join(modules, 'shared'))

    await expect(pruneHarnessRuntime(root, 'macos-arm64')).rejects.toThrow('broken symlink')
  })

  test('removes a missing scoped optional dependency from its owning package', async () => {
    const root = await runtimeFixture()
    const modules = join(root, 'node_modules', '.pnpm', 'owner@1.0.0', 'node_modules')
    await mkdir(join(modules, '@scope', 'owner'), { recursive: true })
    await writeFile(
      join(modules, '@scope', 'owner', 'package.json'),
      JSON.stringify({ optionalDependencies: { '@scope/native': '1.0.0' } })
    )
    const link = join(modules, '@scope', 'native')
    await symlink('../../missing-native', link)

    await pruneHarnessRuntime(root, 'macos-arm64')

    await expectLinkMissing(link)
    await expect(assertPortableHarnessRuntime(root)).resolves.toBeUndefined()
  })

  test('rejects cyclic links even when their package is optional', async () => {
    const root = await runtimeFixture()
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ optionalDependencies: { cyclic: '1.0.0' } })
    )
    const link = join(root, 'node_modules', 'cyclic')
    await symlink('cyclic', link)

    await expect(pruneHarnessRuntime(root, 'macos-arm64')).rejects.toThrow('broken symlink')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })
})

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'harness-runtime-prune-'))
  roots.push(root)
  const directories = [
    ['node-pty', 'prebuilds', 'darwin-arm64'],
    ['node-pty', 'prebuilds', 'darwin-x64'],
    ['node-pty', 'prebuilds', 'linux-x64'],
    ['node-pty', 'prebuilds', 'win32-x64'],
    ['node-pty', 'prebuilds', 'win32-arm64'],
    ['node-pty', 'third_party'],
    ['@reflink', 'reflink'],
    ['@reflink', 'reflink-darwin-arm64'],
    ['@reflink', 'reflink-darwin-x64'],
    ['@reflink', 'reflink-win32-x64-msvc'],
    ['@reflink', 'reflink-win32-arm64-msvc'],
    ['node_modules'],
    ['package'],
  ]
  await Promise.all(directories.map(parts => mkdir(join(root, ...parts), { recursive: true })))
  await Promise.all([
    writeFile(join(root, 'node-pty', 'prebuilds', 'darwin-arm64', 'pty.node'), ''),
    writeFile(join(root, 'node-pty', 'prebuilds', 'darwin-x64', 'pty.node'), ''),
    writeFile(join(root, 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'), ''),
    writeFile(join(root, 'node-pty', 'prebuilds', 'win32-x64', 'pty.node'), ''),
    writeFile(join(root, 'node-pty', 'prebuilds', 'win32-arm64', 'pty.node'), ''),
    writeFile(join(root, 'node-pty', 'third_party', 'source.cc'), ''),
    writeFile(join(root, '@reflink', 'reflink', 'index.js'), ''),
    writeFile(join(root, '@reflink', 'reflink-darwin-arm64', 'reflink.node'), ''),
    writeFile(join(root, '@reflink', 'reflink-darwin-x64', 'reflink.node'), ''),
    writeFile(join(root, '@reflink', 'reflink-win32-x64-msvc', 'reflink.node'), ''),
    writeFile(join(root, '@reflink', 'reflink-win32-arm64-msvc', 'reflink.node'), ''),
    writeFile(join(root, 'node_modules', '.modules.yaml'), 'prunedAt: now\n'),
    writeFile(
      join(root, 'node_modules', '.pnpm-workspace-state-v1.json'),
      JSON.stringify({ lastValidatedTimestamp: Date.now() })
    ),
    writeFile(join(root, 'package', 'index.js'), ''),
    writeFile(join(root, 'package', 'index.js.map'), ''),
    writeFile(join(root, 'package', 'index.d.ts'), ''),
  ])
  return root
}

async function expectExists(path) {
  await expect(access(path)).resolves.toBeUndefined()
}

async function expectMissing(path) {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

async function expectLinkMissing(path) {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
}
