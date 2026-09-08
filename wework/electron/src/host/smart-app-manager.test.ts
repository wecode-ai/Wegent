import { ZipArchive } from 'archiver'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SmartAppManager } from './smart-app-manager.js'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import type { SmartAppVerificationReport } from './smart-app-verification-types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('SmartAppManager', () => {
  test('previews, installs and exports a compatible Smart app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-'))
    roots.push(root)
    const archivePath = await createSmartAppArchive(root, validManifest())
    const manager = createManager(root)

    const preview = await manager.preview(archivePath)
    expect(preview).toMatchObject({
      valid: true,
      manifest: { name: 'fixture-app', version: '1.0.0' },
    })

    const installation = await manager.install({
      archivePath,
      expectedSha256: preview.sha256,
      modelKey: 'fixture-model',
    })
    expect(installation).toMatchObject({
      id: 'fixture-app',
      modelKey: 'fixture-model',
      state: 'installed',
    })
    await expect(
      readFile(join(installation.packagePath, 'app', 'package.json'), 'utf8')
    ).resolves.toContain('"fixture-plugin"')

    const exported = await manager.export(installation.id)
    expect(exported.sizeBytes).toBeGreaterThan(0)
    await expect(manager.preview(exported.archivePath)).resolves.toMatchObject({
      valid: true,
      manifest: { name: 'fixture-app' },
    })

    const saved = await manager.exportToDownloads(installation.id)
    expect(saved.destinationPath).toBe(join(root, 'downloads', 'fixture-app-1.0.0.zip'))
    await expect(manager.preview(saved.destinationPath)).resolves.toMatchObject({
      valid: true,
      manifest: { name: 'fixture-app' },
    })

    const duplicate = await manager.exportToDownloads(installation.id)
    expect(duplicate.destinationPath).toBe(join(root, 'downloads', 'fixture-app-1.0.0 (1).zip'))
  })

  test('previews a standard DSH Release ZIP with declared npm tarballs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-release-'))
    roots.push(root)
    const manifest: WorkbenchAppManifest = {
      ...validManifest(),
      packages: [
        { name: 'fixture-profile', role: 'profile-bundle', path: 'app' },
        { name: 'fixture-host', role: 'host-and-web-plugin', path: 'plugins/host' },
      ],
    }
    const archivePath = await createSmartAppReleaseArchive(root, manifest)

    await expect(createManager(root).preview(archivePath)).resolves.toMatchObject({
      valid: true,
      manifest: { name: 'fixture-app', packages: manifest.packages },
      issues: [],
    })
  })

  test('rejects a DSH Release ZIP missing a declared npm tarball', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-release-'))
    roots.push(root)
    const manifest: WorkbenchAppManifest = {
      ...validManifest(),
      packages: [
        { name: 'fixture-profile', role: 'profile-bundle', path: 'app' },
        { name: 'fixture-host', role: 'host-and-web-plugin', path: 'plugins/host' },
      ],
    }
    const archivePath = await createSmartAppReleaseArchive(root, manifest, 'fixture-host')

    await expect(createManager(root).preview(archivePath)).resolves.toMatchObject({
      valid: false,
      issues: [expect.stringContaining('Smart app npm package is missing: fixture-host')],
    })
  })

  test('rejects package paths escaping the archive root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-invalid-'))
    roots.push(root)
    const archivePath = await createSmartAppArchive(root, {
      ...validManifest(),
      entry: {
        installPackage: '../outside',
        profile: 'fixture',
      },
      packages: [
        {
          name: 'fixture-plugin',
          role: 'profile-bundle',
          path: '../outside',
        },
      ],
    })

    await expect(createManager(root).preview(archivePath)).resolves.toMatchObject({
      valid: false,
      issues: [expect.stringContaining('incomplete identity or entry fields')],
    })
  })

  test('downloads Smart apps from a loopback HTTP marketplace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-download-'))
    roots.push(root)
    const archivePath = await createSmartAppArchive(root, validManifest())
    const archive = await readFile(archivePath)
    const sha256 = createHash('sha256').update(archive).digest('hex')
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'content-length': archive.byteLength,
        'content-type': 'application/zip',
      })
      createReadStream(archivePath).pipe(response)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')

    try {
      await expect(
        createManager(root).download({
          downloadUrl: `http://127.0.0.1:${address.port}/smart-app.zip`,
          sha256,
          sizeBytes: archive.byteLength,
          smartAppId: 1,
          releaseId: 2,
        })
      ).resolves.toMatchObject({
        valid: true,
        manifest: { name: 'fixture-app', version: '1.0.0' },
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    }
  })

  test('rejects Smart app downloads over non-loopback HTTP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-download-'))
    roots.push(root)

    await expect(
      createManager(root).download({
        downloadUrl: 'http://example.com/smart-app.zip',
        sha256: '0'.repeat(64),
        sizeBytes: 1,
        smartAppId: 1,
        releaseId: 2,
      })
    ).rejects.toThrow('Smart app download must use HTTPS')
  })

  test('uploads Smart apps through a loopback HTTP Backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-upload-'))
    roots.push(root)
    const archivePath = join(root, 'smart-app.zip')
    const archive = Buffer.from('smart-app-package')
    await writeFile(archivePath, archive)
    let uploaded = Buffer.alloc(0)
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        uploaded = Buffer.concat(chunks)
        response.writeHead(204)
        response.end()
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')

    try {
      await createManager(root).upload(
        archivePath,
        `http://127.0.0.1:${address.port}/api/smart-apps/submissions/1/artifact`
      )
      expect(uploaded).toEqual(archive)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    }
  })

  test('rejects Smart app uploads over non-loopback HTTP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-upload-'))
    roots.push(root)
    const archivePath = join(root, 'smart-app.zip')
    await writeFile(archivePath, 'smart-app-package')

    await expect(
      createManager(root).upload(archivePath, 'http://example.com/smart-app.zip')
    ).rejects.toThrow('Smart app upload must use HTTPS')
  })

  test('creates linked apps, adds local plugins and copies marketplace apps for editing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-editable-'))
    roots.push(root)
    const parent = join(root, 'projects')
    await mkdir(parent)
    const manager = createManager(root)

    const created = await manager.createDirectory({
      parentPath: parent,
      name: 'created-app',
      displayName: 'Created App',
      description: 'Editable app',
      template: 'web',
    })
    expect(created).toMatchObject({
      id: 'created-app',
      source: 'linked',
      state: 'installed',
    })

    const plugin = join(root, 'fixture-plugin')
    await mkdir(plugin)
    await writeFile(
      join(plugin, 'package.json'),
      `${JSON.stringify({
        name: '@fixture/local-plugin',
        version: '1.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      })}\n`
    )
    await writeFile(join(plugin, 'cordis.patch.yml'), '[]\n')
    const updated = await manager.addPlugin(created.id, plugin)
    expect(updated.manifest.plugins).toEqual([
      {
        spec: 'file:plugins/fixture-local-plugin',
        path: 'plugins/fixture-local-plugin',
      },
    ])

    const archivePath = await createSmartAppArchive(root, validManifest())
    const preview = await manager.preview(archivePath)
    const marketplace = await manager.install({
      archivePath,
      expectedSha256: preview.sha256,
      smartAppId: 42,
      releaseId: 7,
    })
    expect(marketplace.source).toBe('market')

    const copied = await manager.copyToDirectory(marketplace.id, {
      parentPath: parent,
      name: 'copied-app',
      displayName: 'Copied App',
    })
    expect(copied).toMatchObject({
      id: 'copied-app',
      source: 'linked',
      manifest: {
        displayName: 'Copied App',
        version: '0.1.0',
      },
    })

    await manager.delete(created.id, true)
    await expect(
      readFile(join(created.packagePath, 'plugin-manifest.json'), 'utf8')
    ).resolves.toContain('"created-app"')
    await expect(manager.list()).resolves.not.toContainEqual(
      expect.objectContaining({ id: created.id })
    )
  })

  test('refreshes linked package metadata through the shared validator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-refresh-'))
    roots.push(root)
    const parent = join(root, 'projects')
    await mkdir(parent)
    const manager = createManager(root)
    const created = await manager.createDirectory({
      parentPath: parent,
      name: 'refresh-app',
      displayName: 'Refresh App',
      description: 'Refresh fixture',
      template: 'web',
    })
    const manifestPath = join(created.packagePath, 'plugin-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as WorkbenchAppManifest
    manifest.version = '0.2.0'
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(created.packagePath, '.env.local'), 'TOKEN=development-only\n')

    await expect(manager.list()).resolves.toContainEqual(
      expect.objectContaining({
        id: created.id,
        manifest: expect.objectContaining({ version: '0.2.0' }),
        state: 'installed',
      })
    )
  })

  test('rejects unknown scaffold templates before creating a destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-template-'))
    roots.push(root)
    const parent = join(root, 'projects')
    await mkdir(parent)

    await expect(
      createManager(root).createDirectory({
        parentPath: parent,
        name: 'invalid-template',
        displayName: 'Invalid Template',
        description: 'Invalid fixture',
        template: 'browser-with-everything',
      })
    ).rejects.toThrow('Smart app template is invalid')
    await expect(stat(join(parent, 'invalid-template'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('exposes verification only for linked development projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-verification-manager-'))
    roots.push(root)
    const parent = join(root, 'projects')
    await mkdir(parent)
    const report = verificationReport()
    const verificationService = {
      verify: vi.fn().mockResolvedValue(report),
      inspect: vi.fn().mockResolvedValue(report),
      pack: vi.fn().mockResolvedValue({
        archivePath: '/verified.zip',
        sha256: 'verified-sha',
        sizeBytes: 42,
        manifest: validManifest(),
        report,
      }),
    }
    const manager = createManager(root, verificationService)
    const linked = await manager.createDirectory({
      parentPath: parent,
      name: 'verified-app',
      displayName: 'Verified App',
      description: 'Verification fixture',
      template: 'web',
    })

    await expect(manager.verify(linked.id)).resolves.toBe(report)
    await expect(manager.inspectVerification(linked.id)).resolves.toBe(report)
    await expect(manager.verifyProject(linked.packagePath)).resolves.toBe(report)
    await expect(manager.inspectProject(linked.packagePath)).resolves.toBe(report)
    expect(verificationService.verify).toHaveBeenCalledWith(linked.packagePath)
    expect(verificationService.inspect).toHaveBeenCalledWith(linked.packagePath)

    await expect(manager.packProject(linked.packagePath, '/workspace/direct.zip')).resolves.toEqual(
      expect.objectContaining({ archivePath: '/verified.zip' })
    )
    expect(verificationService.pack).toHaveBeenCalledWith(
      linked.packagePath,
      '/workspace/direct.zip'
    )

    await expect(manager.export(linked.id)).resolves.toMatchObject({
      archivePath: '/verified.zip',
      sha256: 'verified-sha',
      sizeBytes: 42,
    })
    expect(verificationService.pack).toHaveBeenCalledWith(
      linked.packagePath,
      expect.stringMatching(/verified-app-0\.1\.0\.zip$/)
    )

    const archivePath = await createSmartAppArchive(root, validManifest())
    const preview = await manager.preview(archivePath)
    const managed = await manager.install({
      archivePath,
      expectedSha256: preview.sha256,
    })
    await expect(manager.verify(managed.id)).rejects.toThrow(
      'Smart app verification is only available for linked projects'
    )
    await expect(manager.export(managed.id)).resolves.toMatchObject({
      manifest: { name: 'fixture-app' },
    })
    expect(verificationService.pack).toHaveBeenCalledTimes(2)
    await expect(manager.inspectProject(parent)).rejects.toThrow(
      'Smart app project is not a linked project root'
    )
  })
})

function createManager(
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
  }
): SmartAppManager {
  return new SmartAppManager({
    dataDirectory: join(root, 'data'),
    downloadsDirectory: join(root, 'downloads'),
    logDirectory: join(root, 'logs'),
    runtimeRoot: join(root, 'runtime'),
    environment: {},
    runtimeHost: () => ({
      open: vi.fn(),
      close: vi.fn(),
      runningTabIds: () => new Set(),
    }),
    verificationService,
  })
}

function verificationReport(): SmartAppVerificationReport {
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

function validManifest(): WorkbenchAppManifest {
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

async function createSmartAppArchive(
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

async function createSmartAppReleaseArchive(
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
