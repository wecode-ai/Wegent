import { ZipArchive } from 'archiver'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SmartAppManager } from './smart-app-manager.js'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'

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
})

function createManager(root: string): SmartAppManager {
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
  })
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
