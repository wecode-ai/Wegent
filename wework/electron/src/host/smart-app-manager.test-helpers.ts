import { ZipArchive } from 'archiver'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as tar from 'tar'
import { vi } from 'vitest'
import { SmartAppManager, type SmartAppRuntimeHost } from './smart-app-manager.js'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import type { SmartAppVerificationReport } from './smart-app-verification-types.js'

export function createManager(
  root: string,
  verificationService?: {
    verify(path: string): Promise<SmartAppVerificationReport>
    inspect(path: string): Promise<SmartAppVerificationReport | null>
    pack(
      path: string,
      output: string
    ): Promise<{
      archivePath: string
      sha256: string
      sizeBytes: number
      manifest: WorkbenchAppManifest
      report: SmartAppVerificationReport
    }>
  },
  environment: NodeJS.ProcessEnv = {},
  runtimeHost: SmartAppRuntimeHost = {
    open: vi.fn(),
    close: vi.fn(),
    runningTabIds: () => new Set(),
  }
): SmartAppManager {
  return new SmartAppManager({
    dataDirectory: join(root, 'data'),
    documentsDirectory: () => join(root, 'Documents'),
    downloadsDirectory: () => join(root, 'downloads'),
    logDirectory: join(root, 'logs'),
    runtimeRoot: join(root, 'runtime'),
    environment,
    runtimeHost: () => runtimeHost,
    verificationService,
  })
}

export function verificationReport(): SmartAppVerificationReport {
  return {
    schemaVersion: 1,
    status: 'passed',
    projectRoot: '/project',
    inputFingerprint: 'input',
    deliverableFingerprint: 'deliverable',
    startedAt: '2026-09-04T00:00:00.000Z',
    finishedAt: '2026-09-04T00:00:01.000Z',
    stages: [],
    issues: [],
  }
}

export function validManifest(): WorkbenchAppManifest {
  return {
    name: 'fixture-app',
    displayName: 'Fixture App',
    version: '1.0.0',
    type: 'deepseek-harness-plugin-bundle',
    description: 'Smart app fixture',
    packages: [
      {
        name: 'fixture-plugin',
        role: 'profile-bundle',
        path: 'app',
      },
    ],
    entry: {
      installPackage: 'app',
      profile: 'fixture',
    },
    requirements: {
      dsh: '0.1.0-rc.8',
      node: '>=24',
    },
  }
}

export async function createSmartAppArchive(
  root: string,
  manifest: WorkbenchAppManifest
): Promise<string> {
  const source = join(root, `source-${Math.random().toString(16).slice(2)}`)
  await mkdir(join(source, 'app'), { recursive: true })
  await writeFile(join(source, 'plugin-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(
    join(source, 'app', 'package.json'),
    `${JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' })}\n`
  )
  const archivePath = `${source}.zip`
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(archivePath)
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolvePromise)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    archive.directory(source, false)
    void archive.finalize()
  })
  return archivePath
}

export async function createSmartAppReleaseArchive(
  root: string,
  manifest: WorkbenchAppManifest,
  omittedPackageName?: string
): Promise<string> {
  const source = join(root, `release-${Math.random().toString(16).slice(2)}`)
  await mkdir(source)
  await writeFile(join(source, 'plugin-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const descriptor of manifest.packages ?? []) {
    if (descriptor.name === omittedPackageName) continue
    const packageRoot = join(root, `npm-${descriptor.name.replaceAll('/', '-')}`)
    await mkdir(join(packageRoot, 'package'), { recursive: true })
    await writeFile(
      join(packageRoot, 'package', 'package.json'),
      `${JSON.stringify({ name: descriptor.name, version: '1.0.0' })}\n`
    )
    await tar.c(
      {
        cwd: packageRoot,
        file: join(source, `${descriptor.name.replaceAll('/', '-')}.tgz`),
        gzip: true,
      },
      ['package']
    )
  }
  const archivePath = `${source}.zip`
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(archivePath)
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolvePromise)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    archive.directory(source, 'fixture-release')
    void archive.finalize()
  })
  return archivePath
}
