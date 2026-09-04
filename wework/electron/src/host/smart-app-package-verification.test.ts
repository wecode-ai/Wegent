import { ZipArchive } from 'archiver'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { validateSmartAppArtifacts } from './smart-app-artifact-validator.js'
import {
  extractSmartAppArchive,
  validateSmartAppPackageDirectory,
} from './smart-app-package-validator.js'
import { scaffoldSmartApp } from './smart-app-scaffold.js'
import {
  SmartAppVerificationError,
  SmartAppVerifier,
  type SmartAppVerifierDependencies,
} from './smart-app-verifier.js'
import { parseSmartAppVerificationContract } from './smart-app-verification-contract.js'
import { fingerprintSmartAppDirectory } from './smart-app-verification-fingerprint.js'
import type { SmartAppVerificationIssue } from './smart-app-verification-types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('verified Smart App delivery archives', () => {
  test('blocks packaging until the project has a current passing report', async () => {
    const root = await project()
    const output = join(root, '..', `unverified-${Date.now()}.zip`)
    roots.push(output)

    await expect(verifier().pack(root, output)).rejects.toMatchObject({
      report: { issues: [expect.objectContaining({ code: 'SA-PACKAGE-UNVERIFIED' })] },
    })
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('publishes only a reverified ZIP and returns its exact hash', async () => {
    const root = await project()
    await writeFile(join(root, '.env.local'), 'TOKEN=secret\n')
    const output = join(root, '..', `verified-${Date.now()}.zip`)
    roots.push(output)

    const service = verifier()
    await service.verify(root)
    const packed = await service.pack(root, output)

    const bytes = await readFile(output)
    expect(packed).toMatchObject({
      archivePath: output,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      manifest: { name: 'verified-app' },
      report: { status: 'passed' },
    })
    expect(packed.report.stages.at(-1)).toMatchObject({ stage: 'package', status: 'passed' })
    const extracted = join(root, '..', `extracted-${Date.now()}`)
    roots.push(extracted)
    await extractSmartAppArchive(output, extracted)
    await expect(stat(join(extracted, '.env.local'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(extracted, 'smart-app.verify.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test('does not create an archive when source verification fails', async () => {
    const root = await project()
    const output = join(root, '..', `failed-${Date.now()}.zip`)
    roots.push(output)
    const scriptsIssue = issue('SA-SCRIPTS-TEST', 'scripts')

    const runScripts = vi
      .fn()
      .mockResolvedValueOnce({ scripts: [], issues: [] })
      .mockResolvedValueOnce({ scripts: [], issues: [scriptsIssue] })
    const service = verifier({ runScripts })
    await service.verify(root)

    await expect(service.pack(root, output)).rejects.toMatchObject({
      name: 'SmartAppVerificationError',
      report: { status: 'failed', issues: [scriptsIssue] },
    })
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects source changes made after verification', async () => {
    const root = await project()
    const output = join(root, '..', `stale-${Date.now()}.zip`)
    roots.push(output)

    const service = verifier()
    await service.verify(root)
    await writeFile(join(root, 'changed.js'), 'changed\n')

    await expect(service.pack(root, output)).rejects.toMatchObject({
      report: { issues: [expect.objectContaining({ code: 'SA-PACKAGE-STALE' })] },
    })
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects a ZIP whose built Client export was omitted', async () => {
    const root = await project()
    const output = join(root, '..', `missing-client-${Date.now()}.zip`)
    roots.push(output)
    const appBundle = join('packages', 'bundle', 'verified-app')

    const service = verifier(
      {},
      {
        archiveDelivery: (source, destination) =>
          zipSelected(source, destination, [
            'plugin-manifest.json',
            'package.json',
            'PLUGIN.md',
            'INSTALL.zh-CN.md',
            'scripts',
            'test',
            `${appBundle}/package.json`,
            `${appBundle}/cordis.patch.yml`,
            `${appBundle}/index.js`,
          ]),
      }
    )
    await service.verify(root)

    await expect(service.pack(root, output)).rejects.toMatchObject({
      report: { issues: [expect.objectContaining({ code: 'SA-CLIENT-EXPORT' })] },
    })
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects a ZIP with multiple manifest roots', async () => {
    const root = await project()
    const output = join(root, '..', `multiple-roots-${Date.now()}.zip`)
    roots.push(output)

    const service = verifier(
      {},
      {
        archiveDelivery: async (source, destination) => {
          await zipSelected(source, destination, ['plugin-manifest.json'])
          await appendManifestRoot(
            destination,
            await readFile(join(source, 'plugin-manifest.json'))
          )
        },
      }
    )
    await service.verify(root)

    await expect(service.pack(root, output)).rejects.toMatchObject({
      report: { issues: [expect.objectContaining({ code: 'SA-PACKAGE-MANIFEST-COUNT' })] },
    })
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects a ZIP that fails isolated runtime verification', async () => {
    const root = await project()
    const output = join(root, '..', `runtime-failure-${Date.now()}.zip`)
    roots.push(output)
    const verifyRuntime = vi
      .fn()
      .mockResolvedValueOnce({ issues: [] })
      .mockResolvedValueOnce({ issues: [] })
      .mockResolvedValueOnce({ issues: [issue('SA-RUNTIME-START', 'runtime')] })
    const service = verifier({ verifyRuntime })
    await service.verify(root)

    await expect(service.pack(root, output)).rejects.toBeInstanceOf(SmartAppVerificationError)
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

function verifier(
  overrides: Partial<SmartAppVerifierDependencies> = {},
  packageOverrides: ConstructorParameters<typeof SmartAppVerifier>[2] = {}
): SmartAppVerifier {
  return new SmartAppVerifier(
    { runtimeRoot: '/runtime', environment: { PATH: '/managed/bin' } },
    {
      validatePackage: path => validateSmartAppPackageDirectory(path, { developmentSource: true }),
      parseContract: parseSmartAppVerificationContract,
      runScripts: vi.fn().mockResolvedValue({ scripts: [], issues: [] }),
      validateArtifacts: validateSmartAppArtifacts,
      verifyRuntime: vi.fn().mockResolvedValue({ issues: [] }),
      fingerprint: fingerprintSmartAppDirectory,
      now: () => new Date('2026-09-04T00:00:00.000Z'),
      ...overrides,
    },
    packageOverrides
  )
}

async function project(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'wework-smart-app-package-verification-'))
  roots.push(parent)
  const root = join(parent, 'verified-app')
  await scaffoldSmartApp({
    path: root,
    name: 'verified-app',
    displayName: 'Verified App',
    description: 'Verified archive fixture',
    dshVersion: '0.1.0-rc.8',
    template: 'web',
  })
  return root
}

async function zipSelected(source: string, destination: string, entries: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destination)
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolve)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    for (const entry of entries) archive.glob(entry, { cwd: source })
    void archive.finalize()
  })
}

async function appendManifestRoot(path: string, manifest: Buffer): Promise<void> {
  const original = await readFile(path)
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(path)
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolve)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    archive.append(original, { name: 'original.zip' })
    archive.append(manifest, { name: 'first/plugin-manifest.json' })
    archive.append(manifest, { name: 'second/plugin-manifest.json' })
    void archive.finalize()
  })
}

function issue(code: string, stage: SmartAppVerificationIssue['stage']): SmartAppVerificationIssue {
  return {
    code,
    stage,
    file: null,
    message: code,
    expected: null,
    actual: null,
    blocking: true,
    hint: null,
  }
}
