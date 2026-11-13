import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import * as tar from 'tar'
import {
  ComponentUpdateManager,
  hashComponentPath,
  MANAGED_COMPONENT_IDS,
  type ManagedComponentId,
  type ComponentUpdateManagerOptions,
} from '../../src/runtime/component-update-manager.js'

export const temporaryDirectories: string[] = []
export const appVersion = '1.2.3-beta.4'
export const updateBaseUrl = 'https://updates.example/releases/download/wework-updater'

export interface Fixture {
  root: string
  resources: string
  data: string
  components: Record<ManagedComponentId, { version: string; path: string; sha256: string }>
}

export async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'wework-components-'))
  temporaryDirectories.push(root)
  const resources = join(root, 'resources')
  const data = join(root, 'data')
  await mkdir(join(resources, 'harness-runtime'), { recursive: true })
  await mkdir(join(resources, 'wework-core-plugins', 'wework-app', 'web'), { recursive: true })
  await mkdir(join(resources, 'wework-core-plugins', 'wework-terminal-runtime'), {
    recursive: true,
  })
  await mkdir(join(resources, 'wework-app-static', 'vendor'), { recursive: true })
  await mkdir(join(resources, 'wework-app-static', 'wasm'), { recursive: true })
  await mkdir(join(resources, 'bundled-plugins'), { recursive: true })
  await mkdir(join(resources, 'bin'), { recursive: true })
  const codexBin = join(resources, 'codex', 'vendor', 'test-target', 'bin')
  await mkdir(codexBin, { recursive: true })
  await writeFile(join(resources, 'harness-runtime', 'runtime.txt'), 'dsh')
  await writeFile(
    join(resources, 'wework-core-plugins', 'wework-app', 'web', 'code.js'),
    'plugin code'
  )
  await writeFile(
    join(resources, 'wework-core-plugins', 'wework-terminal-runtime', 'index.js'),
    'terminal code'
  )
  await writeFile(join(resources, 'wework-app-static', 'vendor', 'static.js'), 'stable static')
  await writeFile(join(resources, 'wework-app-static', 'wasm', 'module.wasm'), 'wasm')
  await writeFile(join(resources, 'bundled-plugins', 'marketplace.json'), 'bundled plugins')
  await writeFile(join(resources, 'bin', 'wegent-executor'), 'executor-v1')
  await writeFile(join(resources, 'bin', 'dws'), 'dws')
  await writeFile(
    join(resources, 'codex', 'WEGENT_CODEX_BINARY.json'),
    JSON.stringify({
      binaryPath: 'vendor/test-target/bin/codex',
    })
  )
  await writeFile(join(codexBin, 'codex'), 'codex')
  await writeFile(join(codexBin, 'codex-code-mode-host'), 'code-mode-host')
  const paths: Record<ManagedComponentId, string> = {
    coreDsh: 'harness-runtime',
    weworkCorePlugins: 'wework-core-plugins',
    weworkAppStatic: 'wework-app-static',
    bundledPlugins: 'bundled-plugins',
    executor: 'bin/wegent-executor',
    codex: 'codex',
    dws: 'bin/dws',
  }
  const components = Object.fromEntries(
    await Promise.all(
      MANAGED_COMPONENT_IDS.map(async id => [
        id,
        {
          version: '1.0.0',
          path: paths[id],
          sha256: await hashComponentPath(join(resources, paths[id])),
        },
      ])
    )
  ) as Fixture['components']
  await writeFile(
    join(resources, 'components.json'),
    JSON.stringify({
      schemaVersion: 1,
      appVersion,
      channel: 'beta',
      components,
    })
  )
  return { root, resources, data, components }
}

export function createManager(
  fixture: Fixture,
  fetch: typeof globalThis.fetch,
  currentAppVersion = appVersion,
  validateExecutor?: ComponentUpdateManagerOptions['validateExecutor']
): ComponentUpdateManager {
  return new ComponentUpdateManager({
    resourcesRoot: fixture.resources,
    dataDirectory: fixture.data,
    updateBaseUrl,
    currentAppVersion,
    platform: 'darwin',
    arch: 'arm64',
    fetch,
    validateExecutor,
  })
}

export async function createExecutorUpdate(
  root: string,
  content: string,
  targetAppVersion = appVersion
) {
  const source = join(root, `source-${content}`)
  const archivePath = join(root, `${content}.tar.gz`)
  await mkdir(source, { recursive: true })
  const executable = join(source, 'wegent-executor')
  await writeFile(executable, content)
  await chmod(executable, 0o755)
  await tar.c(
    {
      cwd: source,
      file: archivePath,
      gzip: true,
      mtime: new Date(0),
      portable: true,
    },
    [basename(executable)]
  )
  const archive = await readFile(archivePath)
  const archiveSha256 = sha256(archive)
  const assetName = `WeworkComponent_executor_${archiveSha256}_macos_arm64.tar.gz`
  const fixture = await readFixture(root)
  const components = Object.fromEntries(
    MANAGED_COMPONENT_IDS.map(id => {
      const packaged = fixture.components[id]
      if (id !== 'executor') {
        return [
          id,
          {
            version: packaged.version,
            contentSha256: packaged.sha256,
            archiveSha256: '0'.repeat(64),
            archiveBytes: 1,
            downloadUrl: `${updateBaseUrl}/unused-${id}.tar.gz`,
            entryPath: '.',
          },
        ]
      }
      return [
        id,
        {
          version: content,
          contentSha256: sha256(Buffer.from(content)),
          archiveSha256,
          archiveBytes: archive.length,
          downloadUrl: `${updateBaseUrl}/${assetName}`,
          entryPath: basename(executable),
        },
      ]
    })
  )
  return {
    assetName,
    archive,
    manifest: {
      schemaVersion: 1,
      appVersion: targetAppVersion,
      channel: 'beta',
      platform: 'macos',
      arch: 'arm64',
      components,
    },
  }
}

export async function createCorePluginUpdate(root: string, content: string) {
  const source = join(root, 'source-core-plugins')
  const archivePath = join(root, 'core-plugins.tar.gz')
  await mkdir(join(source, 'wework-app', 'web'), { recursive: true })
  await writeFile(join(source, 'wework-app', 'web', 'code.js'), content)
  await tar.c(
    {
      cwd: source,
      file: archivePath,
      gzip: true,
      mtime: new Date(0),
      portable: true,
    },
    ['.']
  )
  const archive = await readFile(archivePath)
  const archiveSha256 = sha256(archive)
  const assetName = `WeworkComponent_weworkCorePlugins_${archiveSha256}_macos_arm64.tar.gz`
  const fixture = await readFixture(root)
  const contentSha256 = await hashComponentPath(source)
  const components = Object.fromEntries(
    MANAGED_COMPONENT_IDS.map(id => {
      const packaged = fixture.components[id]
      if (id !== 'weworkCorePlugins') {
        return [
          id,
          {
            version: packaged.version,
            contentSha256: packaged.sha256,
            archiveSha256: '0'.repeat(64),
            archiveBytes: 1,
            downloadUrl: `${updateBaseUrl}/unused-${id}.tar.gz`,
            entryPath: '.',
          },
        ]
      }
      return [
        id,
        {
          version: 'wework-updated',
          contentSha256,
          archiveSha256,
          archiveBytes: archive.length,
          downloadUrl: `${updateBaseUrl}/${assetName}`,
          entryPath: '.',
        },
      ]
    })
  )
  return {
    assetName,
    archive,
    manifest: {
      schemaVersion: 1,
      appVersion,
      channel: 'beta',
      platform: 'macos',
      arch: 'arm64',
      components,
    },
  }
}

export async function createCodexUpdate(root: string, includeHost: boolean) {
  const source = join(root, `source-codex-${includeHost ? 'complete' : 'incomplete'}`)
  const archivePath = join(root, `codex-${includeHost ? 'complete' : 'incomplete'}.tar.gz`)
  const binaryDirectory = join(source, 'vendor', 'test-target', 'bin')
  await mkdir(binaryDirectory, { recursive: true })
  await writeFile(
    join(source, 'WEGENT_CODEX_BINARY.json'),
    JSON.stringify({ binaryPath: 'vendor/test-target/bin/codex' })
  )
  await writeFile(join(binaryDirectory, 'codex'), 'codex-v2')
  if (includeHost) {
    await writeFile(join(binaryDirectory, 'codex-code-mode-host'), 'code-mode-host-v2')
  }
  await tar.c(
    {
      cwd: source,
      file: archivePath,
      gzip: true,
      mtime: new Date(0),
      portable: true,
    },
    ['.']
  )
  const archive = await readFile(archivePath)
  const archiveSha256 = sha256(archive)
  const assetName = `WeworkComponent_codex_${archiveSha256}_macos_arm64.tar.gz`
  const fixture = await readFixture(root)
  const contentSha256 = await hashComponentPath(source)
  const components = Object.fromEntries(
    MANAGED_COMPONENT_IDS.map(id => {
      const packaged = fixture.components[id]
      if (id !== 'codex') {
        return [
          id,
          {
            version: packaged.version,
            contentSha256: packaged.sha256,
            archiveSha256: '0'.repeat(64),
            archiveBytes: 1,
            downloadUrl: `${updateBaseUrl}/unused-${id}.tar.gz`,
            entryPath: '.',
          },
        ]
      }
      return [
        id,
        {
          version: 'codex-v2',
          contentSha256,
          archiveSha256,
          archiveBytes: archive.length,
          downloadUrl: `${updateBaseUrl}/${assetName}`,
          entryPath: '.',
        },
      ]
    })
  )
  return {
    assetName,
    archive,
    manifest: {
      schemaVersion: 1,
      appVersion,
      channel: 'beta',
      platform: 'macos',
      arch: 'arm64',
      components,
    },
  }
}

async function readFixture(root: string): Promise<Fixture> {
  const resources = join(root, 'resources')
  const manifest = JSON.parse(await readFile(join(resources, 'components.json'), 'utf8')) as {
    components: Fixture['components']
  }
  await stat(resources)
  return {
    root,
    resources,
    data: join(root, 'data'),
    components: manifest.components,
  }
}

export function componentFetch(
  manifest: object,
  assetName: string,
  archive: Uint8Array,
  requests: string[] = []
): typeof globalThis.fetch {
  const target = manifest as { platform: string; arch: string }
  return async input => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith(`components-beta-${target.platform}-${target.arch}.json`)) {
      return Response.json(manifest)
    }
    if (url.endsWith(assetName)) return new Response(new Uint8Array(archive).buffer)
    return new Response(null, { status: 404 })
  }
}

export async function writePackagedManifest(
  fixture: Fixture,
  targetAppVersion: string
): Promise<void> {
  await writeFile(
    join(fixture.resources, 'components.json'),
    JSON.stringify({
      schemaVersion: 1,
      appVersion: targetAppVersion,
      channel: 'beta',
      components: fixture.components,
    })
  )
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
