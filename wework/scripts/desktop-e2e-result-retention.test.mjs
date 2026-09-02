import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  compactDesktopE2EResult,
  compactInactiveDesktopE2EResults,
  markDesktopE2EResultActive,
  resolveDesktopE2EResultRoot,
} from '../e2e/desktop/result-retention.mjs'

const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'wework-desktop-e2e-retention-'))
  roots.push(root)
  return root
}

async function createDirectoryWithFile(path) {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'payload'), 'transient\n')
}

async function expectExists(path) {
  await expect(access(path)).resolves.toBeUndefined()
}

async function expectMissing(path) {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('desktop E2E result retention', () => {
  test('resolves the configured or default result root', () => {
    expect(resolveDesktopE2EResultRoot('/repo/wework', {})).toBe(
      join(resolve('/repo/wework'), 'test-results', 'desktop-e2e')
    )
    expect(
      resolveDesktopE2EResultRoot('/repo/wework', {
        WEWORK_E2E_RESULT_ROOT: '/tmp/custom-results',
      })
    ).toBe(resolve('/tmp/custom-results'))
  })

  test('removes rebuildable runtime payloads while preserving diagnostic evidence', async () => {
    const resultDirectory = join(await temporaryRoot(), '2026-09-02T00-00-00-000Z-123')
    const transientDirectories = [
      'WeWork-Electron-E2E-123.app',
      'executor-home',
      'harness-runtime',
      'node-runtime',
      'electron-user-data/Cache',
      'electron-user-data/dsh-core/profiles',
      'electron-user-data/harness-apps/instances/app-1/profiles',
      'electron-user-data/managed-runtimes',
    ]
    await Promise.all(
      transientDirectories.map(path => createDirectoryWithFile(join(resultDirectory, path)))
    )
    await writeFile(join(resultDirectory, 'wegent-executor'), 'binary\n')
    await writeFile(join(resultDirectory, 'app.log'), 'diagnostic\n')
    await createDirectoryWithFile(join(resultDirectory, 'electron-user-data', 'Local Storage'))

    const removed = await compactDesktopE2EResult(resultDirectory)

    expect(removed).toBeGreaterThan(0)
    for (const path of transientDirectories) {
      await expectMissing(join(resultDirectory, path))
    }
    await expectMissing(join(resultDirectory, 'wegent-executor'))
    await expectExists(join(resultDirectory, 'app.log'))
    await expectExists(join(resultDirectory, 'electron-user-data', 'Local Storage', 'payload'))
  })

  test('compacts inactive results without touching a live desktop run', async () => {
    const resultRoot = await temporaryRoot()
    const inactive = join(resultRoot, '2026-09-01T00-00-00-000Z-111')
    const active = join(resultRoot, '2026-09-02T00-00-00-000Z-222')
    await createDirectoryWithFile(join(inactive, 'executor-home'))
    await createDirectoryWithFile(join(active, 'executor-home'))
    await markDesktopE2EResultActive(active, { ownerProcessId: 222 })

    const result = await compactInactiveDesktopE2EResults(resultRoot, {
      isProcessAlive: processId => processId === 222,
    })

    expect(result).toEqual({ compacted: 1, removed: 1 })
    await expectMissing(join(inactive, 'executor-home'))
    await expectExists(join(active, 'executor-home', 'payload'))
    await expectExists(join(active, '.active'))
  })

  test('recognizes a live result before its active marker is written', async () => {
    const resultRoot = await temporaryRoot()
    const active = join(resultRoot, '2026-09-02T00-00-00-000Z-333')
    await createDirectoryWithFile(join(active, 'executor-home'))

    const result = await compactInactiveDesktopE2EResults(resultRoot, {
      isProcessAlive: processId => processId === 333,
    })

    expect(result).toEqual({ compacted: 0, removed: 0 })
    await expectExists(join(active, 'executor-home', 'payload'))
  })

  test('keeps results while their detached application process group is alive', async () => {
    const resultRoot = await temporaryRoot()
    const active = join(resultRoot, '2026-09-02T00-00-00-000Z-444')
    await createDirectoryWithFile(join(active, 'executor-home'))
    await markDesktopE2EResultActive(active, {
      applicationProcessId: 555,
      ownerProcessId: 444,
    })

    const result = await compactInactiveDesktopE2EResults(resultRoot, {
      isApplicationAlive: processId => processId === 555,
      isProcessAlive: () => false,
    })

    expect(result).toEqual({ compacted: 0, removed: 0 })
    await expectExists(join(active, 'executor-home', 'payload'))
  })

  test('ignores unrelated directories with numeric suffixes', async () => {
    const resultRoot = await temporaryRoot()
    const unrelated = join(resultRoot, 'unrelated-666')
    await createDirectoryWithFile(join(unrelated, 'executor-home'))

    const result = await compactInactiveDesktopE2EResults(resultRoot, {
      isProcessAlive: () => false,
    })

    expect(result).toEqual({ compacted: 0, removed: 0 })
    await expectExists(join(unrelated, 'executor-home', 'payload'))
  })
})
