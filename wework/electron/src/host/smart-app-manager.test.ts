import { ZipArchive } from 'archiver'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SmartAppManager, type SmartAppRuntimeHost } from './smart-app-manager.js'
import * as workbenchDshRuntime from '../runtime/workbench-dsh-runtime.js'
import { WorkbenchRuntimeManager } from '../runtime/workbench-runtime.js'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import type { SmartAppVerificationReport } from './smart-app-verification-types.js'

// The manager reaches the cloud through Chromium's network stack; unit tests exercise the HTTP
// protocol against loopback fixtures with Node's implementation instead.
vi.mock('electron', () => ({
  net: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
}))

const roots: string[] = []

const DECISION_ROUTE_TOKEN = `decision-${'a'.repeat(64)}`
const DECISION_ROUTE_URL = `http://127.0.0.1:9500/v1/decision-router/${DECISION_ROUTE_TOKEN}`

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('SmartAppManager', () => {
  test('starts on an OS-assigned port and persists the runtime listening URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-dynamic-port-'))
    roots.push(root)
    const runtimes = new WorkbenchRuntimeManager()
    const launch = vi
      .spyOn(workbenchDshRuntime, 'prepareWorkbenchDshLaunch')
      .mockImplementation(async options => ({
        command: process.execPath,
        entry: 'fixture',
        args: [
          '-e',
          `const server = require('node:http').createServer((_, response) => response.end('ready'))
           server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port))`,
        ],
        cwd: root,
        dshHome: root,
        environment: {},
        profile: options.manifest.entry.profile,
        url: `http://127.0.0.1:${options.port}/`,
        version: '0.1.0-rc.8',
        sourceFingerprint: 'fixture',
      }))
    const manager = createManager(
      root,
      undefined,
      {},
      {
        open: input => runtimes.open(input),
        close: id => runtimes.close(id),
        runningTabIds: () => new Set(runtimes.list().map(item => item.tabId)),
      }
    )
    try {
      const archivePath = await createSmartAppArchive(root, validManifest())
      const preview = await manager.preview(archivePath)
      const installation = await manager.install({ archivePath, expectedSha256: preview.sha256 })
      const started = await manager.start({ installationId: installation.id })

      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ port: 0 }))
      expect(Number(new URL(started.webUrl!).port)).toBeGreaterThan(0)
      expect(started.webUrl).toBe(runtimes.get(`smart-app:${installation.id}`)?.url)
      expect(await (await fetch(started.webUrl!)).text()).toBe('ready')
      expect(await manager.list()).toContainEqual(
        expect.objectContaining({
          id: installation.id,
          state: 'running',
          webUrl: started.webUrl,
        })
      )
    } finally {
      await runtimes.stop()
      launch.mockRestore()
    }
  })

  test('creates a workbench under Documents/WeworkSmartApps when no parent is selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-default-'))
    roots.push(root)
    const manager = createManager(root)

    const created = await manager.createDirectory({
      parentPath: '',
      name: 'default-app',
      displayName: '默认工作台',
      description: '',
      template: 'web',
    })

    expect(created.packagePath).toBe(
      join(await realpath(root), 'Documents', 'WeworkSmartApps', 'default-app')
    )
    expect(created.manifest.description).toBe('')
    expect((await stat(created.packagePath)).isDirectory()).toBe(true)
  })

  test('reports an unavailable default folder and accepts a chosen folder on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-default-error-'))
    roots.push(root)
    await writeFile(join(root, 'Documents'), 'not a directory')
    const manager = createManager(root)
    const input = {
      parentPath: '',
      name: 'chosen-app',
      displayName: 'Chosen App',
      description: '',
      template: 'web',
    }

    await expect(manager.createDirectory(input)).rejects.toThrow(
      'Smart app default save location is unavailable'
    )
    const chosenParent = join(root, 'chosen')
    await mkdir(chosenParent)
    const created = await manager.createDirectory({ ...input, parentPath: chosenParent })
    expect(created.packagePath).toBe(join(await realpath(chosenParent), 'chosen-app'))
  })

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

  test('rejects Smart app upload redirects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-upload-redirect-'))
    roots.push(root)
    const archivePath = join(root, 'smart-app.zip')
    await writeFile(archivePath, 'smart-app-package')
    let redirectedBytes = 0
    const redirectTarget = createServer((request, response) => {
      request.on('data', chunk => {
        redirectedBytes += Buffer.from(chunk).byteLength
      })
      request.on('end', () => {
        response.writeHead(204)
        response.end()
      })
    })
    await new Promise<void>(resolve => redirectTarget.listen(0, '127.0.0.1', resolve))
    const targetAddress = redirectTarget.address()
    if (!targetAddress || typeof targetAddress === 'string') {
      throw new Error('Missing server address')
    }
    const uploadServer = createServer((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${targetAddress.port}/redirected` })
      response.end()
    })
    await new Promise<void>(resolve => uploadServer.listen(0, '127.0.0.1', resolve))
    const uploadAddress = uploadServer.address()
    if (!uploadAddress || typeof uploadAddress === 'string') {
      throw new Error('Missing server address')
    }

    try {
      await expect(
        createManager(root).upload(
          archivePath,
          `http://127.0.0.1:${uploadAddress.port}/api/smart-apps/submissions/1/artifact`
        )
      ).rejects.toThrow()
      expect(redirectedBytes).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) =>
        uploadServer.close(error => (error ? reject(error) : resolve()))
      )
      await new Promise<void>((resolve, reject) =>
        redirectTarget.close(error => (error ? reject(error) : resolve()))
      )
    }
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

  test('grants the decision capability from the manifest declaration alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-capability-'))
    roots.push(root)
    const parent = join(root, 'projects')
    await mkdir(parent)

    const manager = createManager(root)
    const installation = await manager.createDirectory({
      parentPath: parent,
      name: 'decision-linked',
      displayName: 'Decision Linked',
      description: 'Requests the decision router',
      template: 'web',
    })
    expect(installation.grantedCapabilities).toEqual({ decisionModel: false })

    const manifestPath = join(installation.packagePath, 'plugin-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as WorkbenchAppManifest
    manifest.capabilities = { decisionModel: true }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(manager.list()).resolves.toContainEqual(
      expect.objectContaining({
        id: installation.id,
        grantedCapabilities: { decisionModel: true },
      })
    )

    // Neither a build-time allowlist nor a development switch takes part.
    const otherBuild = createManager(root, undefined, {
      WEWORK_DECISION_PROXY_GRANTED_SMART_APP_IDS_JSON: '[]',
      WEWORK_DECISION_PROXY_ALLOW_LINKED_APPS: 'false',
    })
    await expect(otherBuild.list()).resolves.toContainEqual(
      expect.objectContaining({
        id: installation.id,
        grantedCapabilities: { decisionModel: true },
      })
    )
  })

  test('grants a zip-imported install that declares the capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-market-capability-'))
    roots.push(root)
    const archivePath = await createSmartAppArchive(root, {
      ...validManifest(),
      capabilities: { decisionModel: true },
    })
    const manager = createManager(root)
    const preview = await manager.preview(archivePath)

    const installation = await manager.install({
      archivePath,
      expectedSha256: preview.sha256,
    })

    expect(installation).toMatchObject({
      source: 'managed',
      grantedCapabilities: { decisionModel: true },
    })
  })

  test('never grants a capability the manifest does not request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-no-request-'))
    roots.push(root)
    const withoutRequest = await createSmartAppArchive(root, validManifest())
    const manager = createManager(root)

    const preview = await manager.preview(withoutRequest)
    const silent = await manager.install({
      archivePath: withoutRequest,
      expectedSha256: preview.sha256,
      smartAppId: 42,
      releaseId: 1,
    })
    expect(silent.grantedCapabilities).toEqual({ decisionModel: false })
  })

  test('refuses a decision route when the manifest never requested the capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-decision-unauthorized-'))
    roots.push(root)
    const archivePath = await createSmartAppArchive(root, validManifest())
    const manager = createManager(root)
    const preview = await manager.preview(archivePath)
    const installation = await manager.install({
      archivePath,
      expectedSha256: preview.sha256,
      smartAppId: 42,
      releaseId: 1,
    })
    expect(installation.grantedCapabilities).toEqual({ decisionModel: false })

    await expect(
      manager.start({
        installationId: installation.id,
        decisionBaseUrl: DECISION_ROUTE_URL,
        decisionProtocolVersion: 1,
      })
    ).rejects.toThrow('Smart app is not authorized to use the Wework decision router')
  })

  test('rejects malformed decision routes even for a granted installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-decision-malformed-'))
    roots.push(root)
    const archivePath = await createSmartAppArchive(root, {
      ...validManifest(),
      capabilities: { decisionModel: true },
    })
    const manager = createManager(root)
    const preview = await manager.preview(archivePath)
    const installation = await manager.install({
      archivePath,
      expectedSha256: preview.sha256,
      smartAppId: 42,
      releaseId: 1,
    })
    expect(installation.grantedCapabilities).toEqual({ decisionModel: true })

    const rejected = [
      `https://127.0.0.1:9500/v1/decision-router/${DECISION_ROUTE_TOKEN}`,
      `http://attacker.example.com/v1/decision-router/${DECISION_ROUTE_TOKEN}`,
      `http://user:pass@127.0.0.1:9500/v1/decision-router/${DECISION_ROUTE_TOKEN}`,
      `http://127.0.0.1:9500/v1/decision-router/${DECISION_ROUTE_TOKEN}?token=leak`,
      `http://127.0.0.1:9500/v1/decision-router/${DECISION_ROUTE_TOKEN}#fragment`,
      'http://127.0.0.1:9500/v1/decision-router/short',
      `http://127.0.0.1:9500/v2/decision-router/${DECISION_ROUTE_TOKEN}`,
      `http://127.0.0.1:9500/v1/decision-router/${DECISION_ROUTE_TOKEN}/extra`,
      'http://127.0.0.1:9500/v1/decision-router/',
    ]

    for (const decisionBaseUrl of rejected) {
      await expect(
        manager.start({
          installationId: installation.id,
          decisionBaseUrl,
          decisionProtocolVersion: 1,
        })
      ).rejects.toThrow(/Wework decision router base URL/)
    }
  })

  test('rejects an unsupported decision router protocol version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-decision-version-'))
    roots.push(root)
    const archivePath = await createSmartAppArchive(root, {
      ...validManifest(),
      capabilities: { decisionModel: true },
    })
    const manager = createManager(root)
    const preview = await manager.preview(archivePath)
    const installation = await manager.install({
      archivePath,
      expectedSha256: preview.sha256,
      smartAppId: 42,
      releaseId: 1,
    })

    await expect(
      manager.start({
        installationId: installation.id,
        decisionBaseUrl: DECISION_ROUTE_URL,
        decisionProtocolVersion: 2,
      })
    ).rejects.toThrow('Wework decision router protocol version is not supported')
  })

  test('accepts a granted decision route and only then prepares the runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-decision-accepted-'))
    roots.push(root)
    const archivePath = await createSmartAppArchive(root, {
      ...validManifest(),
      capabilities: { decisionModel: true },
    })
    const manager = createManager(root)
    const preview = await manager.preview(archivePath)
    const installation = await manager.install({
      archivePath,
      expectedSha256: preview.sha256,
      smartAppId: 42,
      releaseId: 1,
    })

    // The fixture has no bundled runtime, so the launch fails later; the point
    // is that the address passed validation instead of being rejected here.
    const failure = await manager
      .start({
        installationId: installation.id,
        decisionBaseUrl: DECISION_ROUTE_URL,
        decisionProtocolVersion: 1,
      })
      .then(() => null)
      .catch((error: unknown) => String(error))
    expect(failure).not.toBeNull()
    expect(failure).not.toMatch(/decision router/i)
  })

  test('keeps decision route tokens separate from the generic routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-decision-token-'))
    roots.push(root)
    const manager = createManager(root)
    manager.storeProxyToken('app-1', 'proxy-token')
    manager.storeContextToken('app-1', 'context-token')
    manager.storeDecisionToken('app-1', 'decision-token')

    expect(manager.takeDecisionToken('app-1')).toBe('decision-token')
    expect(manager.takeDecisionToken('app-1')).toBeNull()
    // Taking the decision route must not consume the generic model routes.
    expect(manager.takeProxyToken('app-1')).toBe('proxy-token')
    expect(manager.takeContextToken('app-1')).toBe('context-token')
  })

  test('drops cached route tokens when an installation is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-token-cleanup-'))
    roots.push(root)
    const archivePath = await createSmartAppArchive(root, validManifest())
    const manager = createManager(root)
    const preview = await manager.preview(archivePath)
    const installation = await manager.install({
      archivePath,
      expectedSha256: preview.sha256,
    })
    manager.storeProxyToken(installation.id, 'proxy-token')
    manager.storeContextToken(installation.id, 'context-token')
    manager.storeDecisionToken(installation.id, 'decision-token')

    await manager.delete(installation.id, false)

    expect(manager.takeProxyToken(installation.id)).toBeNull()
    expect(manager.takeContextToken(installation.id)).toBeNull()
    expect(manager.takeDecisionToken(installation.id)).toBeNull()
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

  test('rejects and removes an oversized release archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-oversized-export-'))
    roots.push(root)
    const parent = join(root, 'projects')
    const archivePath = join(root, 'oversized.zip')
    await mkdir(parent)
    await writeFile(archivePath, 'placeholder')
    const report = verificationReport()
    const manager = createManager(root, {
      verify: vi.fn().mockResolvedValue(report),
      inspect: vi.fn().mockResolvedValue(report),
      pack: vi.fn().mockResolvedValue({
        archivePath,
        sha256: 'a'.repeat(64),
        sizeBytes: 50 * 1024 * 1024 + 1,
        manifest: validManifest(),
        report,
      }),
    })
    const linked = await manager.createDirectory({
      parentPath: parent,
      name: 'oversized-app',
      displayName: 'Oversized App',
      description: 'Oversized export fixture',
      template: 'web',
    })

    await expect(manager.export(linked.id)).rejects.toThrow(
      '发布包超过 50 MB，请使用项目打包命令生成发布产物'
    )
    await expect(stat(archivePath)).rejects.toMatchObject({ code: 'ENOENT' })
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
