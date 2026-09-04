import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { scaffoldSmartApp, type SmartAppTemplate } from './smart-app-scaffold.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('scaffoldSmartApp', () => {
  test.each<{
    template: SmartAppTemplate
    capabilities: { host: boolean; client: boolean; remote: boolean }
  }>([
    { template: 'web', capabilities: { host: false, client: true, remote: false } },
    { template: 'host', capabilities: { host: true, client: false, remote: false } },
    { template: 'web-host', capabilities: { host: true, client: true, remote: false } },
    {
      template: 'web-host-remote',
      capabilities: { host: true, client: true, remote: true },
    },
  ])('creates the minimal $template capability structure', async ({ template, capabilities }) => {
    const root = await createFixture(template)
    const bundle = join(root, 'packages', 'bundle', 'contract-app')
    const contract = JSON.parse(await readFile(join(root, 'smart-app.verify.json'), 'utf8'))
    const packageManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const bundleManifest = JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8'))
    const bundlePatch = await readFile(join(bundle, 'cordis.patch.yml'), 'utf8')
    const files = await listFiles(root)

    expect(contract).toMatchObject({
      schemaVersion: 1,
      capabilities,
      scripts: {
        typecheck: 'typecheck',
        test: 'test',
        build: 'build',
      },
      runtime: {
        profile: 'web',
        path: '/',
        readySelector:
          template === 'host'
            ? 'body'
            : capabilities.remote
              ? '[data-testid="smart-app-ready"][data-remote="passed"]'
              : '[data-testid="smart-app-ready"]',
      },
    })
    expect(Object.keys(packageManifest.scripts)).toEqual(
      capabilities.remote
        ? ['typecheck', 'test', 'build', 'runtime:probe']
        : ['typecheck', 'test', 'build']
    )
    expect(contract.scripts.runtimeProbe).toBe(capabilities.remote ? 'runtime:probe' : undefined)
    expect(files).toContain('plugin-manifest.json')
    expect(files).toContain('smart-app.verify.json')
    expect(files).toContain('scripts/build.mjs')
    expect(files).toContain('test/contracts.test.mjs')

    if (capabilities.client) {
      expect(bundleManifest.exports).toMatchObject({
        './client': './client.js',
        './package.json': './package.json',
      })
      expect(bundleManifest.dsh.client.inject).toEqual([
        '@deepseek-ai/dsh-client-runtime',
        ...(capabilities.remote ? ['@deepseek-ai/dsh-api-gateway'] : []),
      ])
      expect(files).toContain('packages/bundle/contract-app/src/client.js')
      expect(files).toContain('packages/bundle/contract-app/client.js')
      const client = await readFile(join(bundle, 'client.js'), 'utf8')
      expect(client).toContain('window.__ModuleLoader__.load')
      expect(client).toContain("name: 'root'")
      expect(client).toContain('data-testid')
      expect(client).toContain('smart-app-ready')
      expect(bundlePatch).toContain('id: ui-conversation\n  disabled: true')
      expect(bundlePatch).toContain('id: ui-sidebar\n  disabled: true')
    } else {
      expect(bundleManifest.exports).not.toHaveProperty('./client')
      expect(bundleManifest.dsh).not.toHaveProperty('client')
      expect(files).not.toContain('packages/bundle/contract-app/src/client.js')
      expect(files).not.toContain('packages/bundle/contract-app/client.js')
      expect(bundlePatch).not.toContain('id: ui-conversation')
    }

    if (capabilities.host) {
      expect(files).toContain('packages/bundle/contract-app/src/host.js')
    } else {
      expect(files).not.toContain('packages/bundle/contract-app/src/host.js')
    }

    const generated = await Promise.all(files.map(file => readFile(join(root, file), 'utf8')))
    expect(generated.join('\n')).not.toMatch(/ctx\.harness|inject.*['"]llm['"]|dashboard|excel/i)
  })

  test('uses a generic health.ping round trip for the Remote template', async () => {
    const root = await createFixture('web-host-remote')
    const bundle = join(root, 'packages', 'bundle', 'contract-app')
    const contract = JSON.parse(await readFile(join(root, 'smart-app.verify.json'), 'utf8'))
    const remote = await readFile(join(bundle, 'src', 'remote.js'), 'utf8')
    const host = await readFile(join(bundle, 'src', 'host.js'), 'utf8')
    const client = await readFile(join(bundle, 'src', 'client.js'), 'utf8')

    expect(remote).toContain("service: 'health'")
    expect(remote).toContain("method: 'ping'")
    expect(host).toContain("super(ctx, 'health')")
    expect(host).toContain("Remote('ping')")
    expect(client).toContain('remote.health.ping()')
    expect(contract.runtime.readySelector).toBe(
      '[data-testid="smart-app-ready"][data-remote="passed"]'
    )
  })

  test.each<SmartAppTemplate>(['web', 'host', 'web-host', 'web-host-remote'])(
    'generates executable project checks for %s',
    async template => {
      const root = await createFixture(template)

      await execFileAsync(process.execPath, ['scripts/typecheck.mjs'], { cwd: root })
      await execFileAsync(process.execPath, ['--test'], { cwd: root })
      await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: root })
    }
  )
})

async function createFixture(template: SmartAppTemplate): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'wework-smart-app-scaffold-'))
  roots.push(parent)
  const root = join(parent, 'contract-app')
  await scaffoldSmartApp({
    path: root,
    name: 'contract-app',
    displayName: 'Contract App',
    description: 'Generic fixture',
    dshVersion: '0.1.0-rc.8',
    template,
  })
  return root
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else files.push(relative(root, path).split('\\').join('/'))
    }
  }
  await visit(root)
  return files.sort()
}
