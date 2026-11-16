// @vitest-environment node

import { access, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { pruneHarnessRuntime } from './harness-runtime-pruning.mjs'

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

  test('removes dangling dependency links left by partial installs', async () => {
    const root = await runtimeFixture()
    const packageDependencies = join(root, 'node_modules', '.pnpm', 'package@1.0.0', 'node_modules')
    await mkdir(join(packageDependencies, 'package'), { recursive: true })
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
    await symlink('pruned-package', join(packageDependencies, 'pruned-optional'))
    const prunedDirectory = join(root, 'node_modules', 'pruned-package')
    await mkdir(prunedDirectory, { recursive: true })
    await writeFile(join(prunedDirectory, 'index.d.ts'), '')

    await pruneHarnessRuntime(root, 'macos-arm64')

    await expectLinkMissing(join(packageDependencies, 'pruned-optional'))
    await expectExists(join(packageDependencies, 'present-optional'))
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
    ['node-pty', 'third_party'],
    ['@reflink', 'reflink'],
    ['@reflink', 'reflink-darwin-arm64'],
    ['@reflink', 'reflink-darwin-x64'],
    ['@reflink', 'reflink-win32-x64-msvc'],
    ['node_modules'],
    ['package'],
  ]
  await Promise.all(directories.map(parts => mkdir(join(root, ...parts), { recursive: true })))
  await Promise.all([
    writeFile(join(root, 'node-pty', 'prebuilds', 'darwin-arm64', 'pty.node'), ''),
    writeFile(join(root, 'node-pty', 'prebuilds', 'darwin-x64', 'pty.node'), ''),
    writeFile(join(root, 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'), ''),
    writeFile(join(root, 'node-pty', 'prebuilds', 'win32-x64', 'pty.node'), ''),
    writeFile(join(root, 'node-pty', 'third_party', 'source.cc'), ''),
    writeFile(join(root, '@reflink', 'reflink', 'index.js'), ''),
    writeFile(join(root, '@reflink', 'reflink-darwin-arm64', 'reflink.node'), ''),
    writeFile(join(root, '@reflink', 'reflink-darwin-x64', 'reflink.node'), ''),
    writeFile(join(root, '@reflink', 'reflink-win32-x64-msvc', 'reflink.node'), ''),
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
