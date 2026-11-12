import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { validateSmartAppArtifacts } from './smart-app-artifact-validator.js'
import { createManager } from './smart-app-manager.test-helpers.js'
import { validateSmartAppPackageDirectory } from './smart-app-package-validator.js'
import { parseSmartAppVerificationContract } from './smart-app-verification-contract.js'
import { fingerprintSmartAppDirectory } from './smart-app-verification-fingerprint.js'
import { SmartAppVerifier } from './smart-app-verifier.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('uninstalled workbench source verification', () => {
  test.each(['lightweight', 'extended'] as const)(
    'checks and packs %s source before any installation exists',
    async flavor => {
      const { root, manager, runtimeHost } = await fixture()
      const { projectPath } = await manager.scaffold({
        projectPath: join(root, 'calculator'),
        name: 'calculator',
        displayName: 'Calculator',
        flavor,
      })
      await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: projectPath })

      await expect(manager.inspectProject(projectPath)).resolves.toBeNull()
      await expect(manager.verifyProject(projectPath)).resolves.toMatchObject({
        status: 'passed',
        projectRoot: projectPath,
      })
      await expect(manager.inspectProject(projectPath)).resolves.toMatchObject({ status: 'passed' })
      const packed = await manager.packProject(projectPath, join(root, 'calculator.zip'))
      expect(packed).toMatchObject({
        manifest: { name: 'calculator', flavor },
        report: { status: 'passed' },
      })
      expect((await stat(packed.archivePath)).size).toBe(packed.sizeBytes)
      await expect(manager.list()).resolves.toEqual([])
      await expect(stat(join(root, 'data/harness-apps/installations.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(runtimeHost.open).not.toHaveBeenCalled()
    }
  )

  test('invalidates changed source and requires verification before packaging it again', async () => {
    const { root, manager } = await fixture()
    const projectPath = join(root, 'calculator')
    await manager.scaffold({
      projectPath,
      name: 'calculator',
      displayName: 'Calculator',
      flavor: 'lightweight',
    })
    await expect(
      manager.packProject(projectPath, join(root, 'calculator.zip'))
    ).rejects.toMatchObject({
      report: { issues: [expect.objectContaining({ code: 'SA-PACKAGE-UNVERIFIED' })] },
    })
    expect((await manager.verifyProject(projectPath)).status).toBe('passed')
    await writeFile(join(projectPath, 'view.html'), '<main>Changed calculator</main>')
    await expect(manager.inspectProject(projectPath)).resolves.toMatchObject({ status: 'stale' })
    await expect(
      manager.packProject(projectPath, join(root, 'calculator.zip'))
    ).rejects.toMatchObject({
      report: { issues: [expect.objectContaining({ code: 'SA-PACKAGE-STALE' })] },
    })
    await expect(stat(join(root, 'calculator.zip'))).rejects.toMatchObject({ code: 'ENOENT' })
    await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: projectPath })
    expect((await manager.verifyProject(projectPath)).status).toBe('passed')
    await expect(
      manager.packProject(projectPath, join(root, 'calculator.zip'))
    ).resolves.toMatchObject({
      report: { status: 'passed' },
    })
  })

  test('reports invalid source and refuses packaging without creating an installation', async () => {
    const { root, manager, verifyRuntime } = await fixture()
    const projectPath = join(root, 'calculator')
    await manager.scaffold({
      projectPath,
      name: 'calculator',
      displayName: 'Calculator',
      flavor: 'lightweight',
    })
    await writeFile(join(projectPath, 'plugin-manifest.json'), '{}')
    const report = await manager.verifyProject(projectPath)
    expect(report.status).toBe('failed')
    expect(report.stages[0]).toMatchObject({ stage: 'manifest', status: 'failed' })
    await expect(
      manager.packProject(projectPath, join(root, 'calculator.zip'))
    ).rejects.toMatchObject({
      report: { status: 'failed' },
    })
    expect(verifyRuntime).not.toHaveBeenCalled()
    await expect(manager.list()).resolves.toEqual([])
  })

  test('rejects missing or non-directory source for every project operation', async () => {
    const { root, manager } = await fixture()
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'source')
    for (const projectPath of [file, join(root, 'missing')]) {
      await expect(manager.inspectProject(projectPath)).rejects.toThrow()
      await expect(manager.verifyProject(projectPath)).rejects.toThrow()
      await expect(manager.packProject(projectPath, join(root, 'invalid.zip'))).rejects.toThrow()
    }
  })
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wework-source-verification-')))
  roots.push(root)
  const runtimeHost = { open: vi.fn(), close: vi.fn(), runningTabIds: () => new Set<string>() }
  const verifyRuntime = vi.fn().mockResolvedValue({ issues: [] })
  // Exercise the real directory, report, fingerprint and archive contracts without starting Electron.
  const verifier = new SmartAppVerifier(
    { runtimeRoot: join(root, 'runtime'), environment: {} },
    {
      validatePackage: path => validateSmartAppPackageDirectory(path, { developmentSource: true }),
      parseContract: parseSmartAppVerificationContract,
      runScripts: vi.fn().mockResolvedValue({ scripts: [], issues: [] }),
      validateArtifacts: validateSmartAppArtifacts,
      verifyRuntime,
      fingerprint: fingerprintSmartAppDirectory,
      now: () => new Date(),
    }
  )
  return {
    root,
    manager: createManager(root, verifier, {}, runtimeHost),
    runtimeHost,
    verifyRuntime,
  }
}
