import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { assertPortableHarnessRuntime } from './lib/portable-runtime.mjs'

const temporaryDirectories = []

async function createTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wework-portable-runtime-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

describe('assertPortableHarnessRuntime', () => {
  test('accepts dependency links that resolve inside the runtime', async () => {
    const runtime = await createTemporaryDirectory()
    const packageDirectory = path.join(runtime, 'node_modules', '.pnpm', 'package')
    const dependencyLink = path.join(runtime, 'node_modules', 'package')
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(path.join(packageDirectory, 'package.json'), '{}')
    await symlink(path.relative(path.dirname(dependencyLink), packageDirectory), dependencyLink)

    await expect(assertPortableHarnessRuntime(runtime)).resolves.toBeUndefined()
  })

  test('rejects dependency links into the package manager global store', async () => {
    const runtime = await createTemporaryDirectory()
    const globalStore = await createTemporaryDirectory()
    const dependencyLink = path.join(runtime, 'node_modules', 'package')
    await mkdir(path.dirname(dependencyLink), { recursive: true })
    await symlink(globalStore, dependencyLink)

    await expect(assertPortableHarnessRuntime(runtime)).rejects.toThrow(
      'Harness runtime symlink escapes the archive root'
    )
  })

  test('rejects broken dependency links', async () => {
    const runtime = await createTemporaryDirectory()
    const dependencyLink = path.join(runtime, 'node_modules', 'package')
    await mkdir(path.dirname(dependencyLink), { recursive: true })
    await symlink('../missing-package', dependencyLink)

    await expect(assertPortableHarnessRuntime(runtime)).rejects.toThrow(
      'Harness runtime contains a broken symlink'
    )
  })
})
