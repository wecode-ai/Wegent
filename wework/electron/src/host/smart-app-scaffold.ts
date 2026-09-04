import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import type { SmartAppVerificationContract } from './smart-app-verification-types.js'

export const SMART_APP_TEMPLATES = ['web', 'host', 'web-host', 'web-host-remote'] as const

export type SmartAppTemplate = (typeof SMART_APP_TEMPLATES)[number]

export interface SmartAppScaffoldInput {
  path: string
  name: string
  displayName: string
  description: string
  dshVersion: string
  template: SmartAppTemplate
}

export async function scaffoldSmartApp(input: SmartAppScaffoldInput): Promise<void> {
  const capabilities = templateCapabilities(input.template)
  const packageName = `@wework-smart-app/${input.name}`
  const bundlePath = `packages/bundle/${input.name}`
  const bundle = join(input.path, bundlePath)
  await mkdir(join(bundle, 'src'), { recursive: true, mode: 0o700 })
  await mkdir(join(input.path, 'scripts'), { recursive: true, mode: 0o700 })
  await mkdir(join(input.path, 'test'), { recursive: true, mode: 0o700 })

  const manifest: WorkbenchAppManifest = {
    name: input.name,
    displayName: input.displayName,
    version: '0.1.0',
    type: 'deepseek-harness-plugin-bundle',
    description: input.description,
    packages: [{ name: packageName, role: 'profile-bundle', path: bundlePath }],
    entry: { installPackage: bundlePath, profile: 'web' },
    requirements: { dsh: input.dshVersion, node: '>=22' },
    plugins: [],
  }
  const scripts: Record<string, string> = {
    typecheck: 'node scripts/typecheck.mjs',
    test: 'node --test',
    build: 'node scripts/build.mjs',
  }
  if (capabilities.remote) scripts['runtime:probe'] = 'node scripts/runtime-probe.mjs'
  const contract: SmartAppVerificationContract = {
    schemaVersion: 1,
    scripts: {
      typecheck: 'typecheck',
      test: 'test',
      build: 'build',
      ...(capabilities.remote ? { runtimeProbe: 'runtime:probe' } : {}),
    },
    capabilities,
    runtime: {
      profile: 'web',
      path: '/',
      readySelector: capabilities.remote
        ? '[data-testid="smart-app-ready"][data-remote="passed"]'
        : capabilities.client
          ? '[data-testid="smart-app-ready"]'
          : 'body',
    },
  }

  await writeJson(join(input.path, 'plugin-manifest.json'), manifest)
  await writeJson(join(input.path, 'smart-app.verify.json'), contract)
  await writeJson(join(input.path, 'package.json'), {
    name: `${packageName}-workspace`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts,
  })
  await writeBundle(input, packageName, bundle, capabilities)
  await writeProjectTools(input, bundlePath, capabilities)
  await writeFile(
    join(input.path, 'PLUGIN.md'),
    `# ${input.displayName}\n\n${input.description}\n\nTemplate: ${input.template}. Add only the services this Smart App actually uses.\n`
  )
  await writeFile(
    join(input.path, 'INSTALL.zh-CN.md'),
    '# 安装\n\n可在 Wework 中直接关联此目录运行，或通过验证后导出 ZIP 安装。\n'
  )
}

function templateCapabilities(template: SmartAppTemplate) {
  return {
    host: template !== 'web',
    client: template !== 'host',
    remote: template === 'web-host-remote',
  }
}

async function writeBundle(
  input: SmartAppScaffoldInput,
  packageName: string,
  bundle: string,
  capabilities: ReturnType<typeof templateCapabilities>
): Promise<void> {
  const exports: Record<string, string> = {
    '.': './index.js',
    './package.json': './package.json',
  }
  if (capabilities.client) exports['./client'] = './client.js'
  if (capabilities.remote) {
    exports['./remote'] = './remote.js'
    exports['./typert'] = './typert.host.js'
  }
  const dsh: Record<string, unknown> = { bundle: { patch: './cordis.patch.yml' } }
  if (capabilities.client) {
    dsh.client = {
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        ...(capabilities.remote ? ['@deepseek-ai/dsh-api-gateway'] : []),
      ],
      platform: 'web',
    }
  }
  const dependencies: Record<string, string> = {}
  const peerDependencies: Record<string, string> = {}
  if (capabilities.client) {
    peerDependencies['@deepseek-ai/dsh-client-runtime'] = input.dshVersion
    peerDependencies.react = '^18.2.0'
  }
  if (capabilities.remote) {
    dependencies.zod = '4.4.3'
    peerDependencies['@deepseek-ai/dsh-api-gateway'] = input.dshVersion
    peerDependencies['@deepseek-ai/dsh-typert-protocol'] = input.dshVersion
  }
  await writeJson(join(bundle, 'package.json'), {
    name: packageName,
    version: '0.1.0',
    private: true,
    type: 'module',
    main: './index.js',
    exports,
    files: [
      'cordis.patch.yml',
      'src',
      'index.js',
      ...(capabilities.host ? ['host.js'] : []),
      ...(capabilities.client ? ['client.js'] : []),
      ...(capabilities.remote ? ['remote.js', 'typert.host.js'] : []),
    ],
    dsh,
    ...(Object.keys(dependencies).length ? { dependencies } : {}),
    ...(Object.keys(peerDependencies).length ? { peerDependencies } : {}),
  })
  await writeFile(
    join(bundle, 'cordis.patch.yml'),
    `${capabilities.client ? disabledDefaultWebModules() : ''}- insert:\n    - id: ${input.name}\n      name: '${packageName}'\n`
  )
  const indexSource = capabilities.host
    ? `import { applyHost } from './host.js'\n\nexport const name = '${input.name}'\nexport const inject = []\nexport const apply = applyHost\n`
    : `export const name = '${input.name}'\nexport const inject = []\nexport function apply() {}\n`
  await writeFile(join(bundle, 'src', 'index.js'), indexSource)
  await writeFile(join(bundle, 'index.js'), indexSource)
  if (capabilities.host) {
    const hostSource = capabilities.remote ? remoteHostSource() : 'export function applyHost() {}\n'
    await writeFile(join(bundle, 'src', 'host.js'), hostSource)
    await writeFile(join(bundle, 'host.js'), hostSource)
  }
  if (capabilities.remote) {
    const remoteSource = remoteDescriptorSource(packageName)
    const typertSource = typertHostSource()
    await writeFile(join(bundle, 'src', 'remote.js'), remoteSource)
    await writeFile(join(bundle, 'src', 'typert.host.js'), typertSource)
    await writeFile(join(bundle, 'remote.js'), remoteSource)
    await writeFile(join(bundle, 'typert.host.js'), typertSource)
  }
  if (capabilities.client) {
    const clientSource = clientModuleSource(packageName, input.displayName, capabilities.remote)
    await writeFile(join(bundle, 'src', 'client.js'), clientSource)
    await writeFile(join(bundle, 'client.js'), clientSource)
  }
}

function disabledDefaultWebModules(): string {
  return [
    'ui-conversation',
    'ui-sidebar',
    'ui-settings-general',
    'ui-settings-models',
    'ui-settings-plugin-inventory',
  ]
    .map(id => `- id: ${id}\n  disabled: true\n`)
    .join('')
}

async function writeProjectTools(
  input: SmartAppScaffoldInput,
  bundlePath: string,
  capabilities: ReturnType<typeof templateCapabilities>
): Promise<void> {
  const outputs = ['index.js']
  if (capabilities.host) outputs.push('host.js')
  if (capabilities.client) outputs.push('client.js')
  if (capabilities.remote) outputs.push('remote.js', 'typert.host.js')
  await writeFile(
    join(input.path, 'scripts', 'build.mjs'),
    `import { copyFile } from 'node:fs/promises'\n\nconst bundle = new URL('../${bundlePath}/', import.meta.url)\nfor (const file of ${JSON.stringify(outputs)}) {\n  await copyFile(new URL(\`src/\${file}\`, bundle), new URL(file, bundle))\n}\n`
  )
  await writeFile(
    join(input.path, 'scripts', 'typecheck.mjs'),
    `import { spawnSync } from 'node:child_process'\n\nconst files = ${JSON.stringify(outputs.map(file => `${bundlePath}/src/${file}`))}\nfor (const file of files) {\n  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })\n  if (result.status !== 0) process.exit(result.status ?? 1)\n}\n`
  )
  if (capabilities.remote) {
    await writeFile(
      join(input.path, 'scripts', 'runtime-probe.mjs'),
      "const baseUrl = process.env.SMART_APP_BASE_URL\nif (!baseUrl) throw new Error('SMART_APP_BASE_URL is required')\nconst response = await fetch(new URL('/', baseUrl))\nif (!response.ok) throw new Error(`Smart App returned HTTP ${response.status}`)\n"
    )
  }
  await writeFile(
    join(input.path, 'test', 'contracts.test.mjs'),
    generatedContractTest(bundlePath, capabilities)
  )
}

function clientModuleSource(packageName: string, displayName: string, remote: boolean): string {
  const remoteSetup = remote
    ? `const healthSchema = {
        parse(value) {
          if (value?.ok === true) return value
          throw new TypeError('health.ping returned an invalid result')
        },
      }
      const contribution = {
        package: '${packageName}',
        descriptors: [{
          id: '${packageName}#health/ping',
          service: 'health',
          namespace: 'health',
          method: 'ping',
          invocation: { kind: 'direct' },
          parameters: [],
          result: { mode: 'strict', typeSymbol: '${packageName}#Health', schema: healthSchema },
        }],
      }`
    : ''
  const component = remote
    ? `function SmartAppRoot({ remote }) {
        const [passed, setPassed] = React.useState(false)
        React.useEffect(() => { void remote.health.ping().then(result => setPassed(result.ok === true && result.value?.ok === true)) }, [remote])
        return React.createElement('main', {
          'data-testid': 'smart-app-ready',
          'data-remote': passed ? 'passed' : 'pending',
        }, '${escapeJavaScript(displayName)}')
      }`
    : `function SmartAppRoot() {
        return React.createElement('main', { 'data-testid': 'smart-app-ready' }, '${escapeJavaScript(displayName)}')
      }`
  const apply = remote
    ? `async apply(ctx) {
          const disposeRemote = await ctx.remote.$mount(contribution)
          let disposeRoot
          const fiber = ctx.inject(['remote.health'], scope => {
            disposeRoot = ctx.slots.register({ name: 'root', priority: -1 }, () => React.createElement(SmartAppRoot, { remote: scope.remote }))
          })
          await fiber
          return async () => { disposeRoot?.(); await fiber.dispose(); await disposeRemote() }
        }`
    : `apply(ctx) {
          return ctx.slots.register({ name: 'root', priority: -1 }, SmartAppRoot)
        }`
  return `window.__ModuleLoader__.load({
  id: '${packageName}',
  factory: require => {
    const React = require('react')
    ${remoteSetup}
    ${component}
    return {
      inject: ${remote ? "['slots', 'remote']" : "['slots']"},
      ${apply},
    }
  },
})
`
}

function remoteDescriptorSource(packageName: string): string {
  return `import { z } from 'zod'\n\nexport const TYPERT_REMOTE = {\n  package: '${packageName}',\n  descriptors: [{\n    id: '${packageName}#health/ping',\n    service: 'health',\n    namespace: 'health',\n    method: 'ping',\n    invocation: { kind: 'direct' },\n    parameters: [],\n    result: { mode: 'strict', typeSymbol: '${packageName}#Health', schema: z.object({ ok: z.literal(true) }) },\n  }],\n}\n\nexport default TYPERT_REMOTE\n`
}

function remoteHostSource(): string {
  return `export async function applyHost(ctx) {\n  const { Remote, TypertRemoteService } = await import('@deepseek-ai/dsh-typert-protocol')\n  const healthInitializers = []\n  class HealthService extends TypertRemoteService {\n    constructor(ctx) {\n      super(ctx, 'health')\n      for (const initialize of healthInitializers) initialize.call(this)\n    }\n    async ping() { return { ok: true } }\n  }\n  Remote('ping')(HealthService.prototype.ping, {\n    kind: 'method',\n    name: 'ping',\n    static: false,\n    private: false,\n    addInitializer(initialize) { healthInitializers.push(initialize) },\n  })\n  new HealthService(ctx)\n}\n`
}

function typertHostSource(): string {
  return `import { TYPERT_REMOTE } from './remote.js'\n\nexport const TYPERT = {\n  package: TYPERT_REMOTE.package,\n  face: 'host',\n  schemas: [],\n  invocations: TYPERT_REMOTE.descriptors,\n  model: { services: [{ tags: [], key: 'health', exportName: 'HealthService', members: [{ kind: 'method', name: 'ping', signature: "@Remote('ping') async ping(): Promise<{ ok: true }>" }], types: [] }], events: [], objects: [] },\n}\n`
}

function generatedContractTest(
  bundlePath: string,
  capabilities: ReturnType<typeof templateCapabilities>
): string {
  const clientInject = capabilities.client
    ? [
        '@deepseek-ai/dsh-client-runtime',
        ...(capabilities.remote ? ['@deepseek-ai/dsh-api-gateway'] : []),
      ]
    : []
  return `import assert from 'node:assert/strict'\nimport { readFile } from 'node:fs/promises'\nimport test from 'node:test'\n\nconst bundle = new URL('../${bundlePath}/', import.meta.url)\n\ntest('package exposes only declared capabilities', async () => {\n  const packageManifest = JSON.parse(await readFile(new URL('package.json', bundle), 'utf8'))\n  assert.equal(Boolean(packageManifest.exports['./client']), ${capabilities.client})\n  assert.equal(Boolean(packageManifest.exports['./remote']), ${capabilities.remote})\n  assert.deepEqual(packageManifest.dsh.client?.inject ?? [], ${JSON.stringify(clientInject)})\n})\n`
}

function escapeJavaScript(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', ' ')
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}
