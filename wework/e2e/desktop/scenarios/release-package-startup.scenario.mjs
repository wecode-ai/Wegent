import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'

const PROFILE_NAME = 'wework-core'
const NATIVE_PROVIDER = '@wework-e2e/native-dsh-provider'
const NATIVE_CONSUMER = '@wework-e2e/native-dsh-consumer'

async function writePlugin(profileRoot, name, manifest, files) {
  const pluginRoot = join(profileRoot, 'node_modules', name)
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(join(pluginRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const destination = join(pluginRoot, path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, content)
    })
  )
}

async function seedTauriProfile(userDataDirectory) {
  const profileRoot = join(userDataDirectory, 'dsh-core', 'profiles', PROFILE_NAME)
  await mkdir(profileRoot, { recursive: true })
  await writeFile(
    join(profileRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${PROFILE_NAME}`,
        private: true,
        dependencies: {
          [NATIVE_CONSUMER]: 'file:./fixtures/native-dsh-consumer',
        },
        dsh: {
          profile: {
            bundles: [NATIVE_CONSUMER],
          },
        },
      },
      null,
      2
    )}\n`
  )
  await writeFile(join(profileRoot, 'cordis.yml'), '[]\n')
  await writeFile(join(profileRoot, 'cordis.patch.yml'), '[]\n')

  await writePlugin(
    profileRoot,
    NATIVE_PROVIDER,
    {
      name: NATIVE_PROVIDER,
      version: '2.1.0',
      type: 'module',
      main: 'index.js',
      exports: {
        '.': './index.js',
        './client': './client.js',
        './package.json': './package.json',
      },
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: {
          inject: ['@deepseek-ai/dsh-client-runtime'],
          platform: 'web',
        },
      },
    },
    {
      'cordis.patch.yml':
        "- insert:\n    - id: native-dsh-provider\n      name: '@wework-e2e/native-dsh-provider'\n",
      'index.js': `export function apply(ctx) {
  ctx.provide('nativeServerProvider', {
    register() {
      return () => {}
    },
  })
}
`,
      'client.js': `window.__ModuleLoader__.load({
  id: '@wework-e2e/native-dsh-provider',
  factory: () => {
    document.body.setAttribute('data-native-dsh-provider-loaded', '')
    return {
      inject: [],
      apply(ctx) {
        ctx.provide('nativeExtensionHost', {
          registerExtension() {
            return () => {}
          },
        })
        document.body.setAttribute('data-native-dsh-provider-active', '')
      },
    }
  },
})
`,
    }
  )
  await writePlugin(
    profileRoot,
    NATIVE_CONSUMER,
    {
      name: NATIVE_CONSUMER,
      version: '1.3.0',
      type: 'module',
      main: 'index.js',
      exports: {
        '.': './index.js',
        './client': './client.js',
        './package.json': './package.json',
      },
      peerDependencies: {
        [NATIVE_PROVIDER]: '^2.0.0',
      },
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: {
          inject: ['@deepseek-ai/dsh-client-runtime'],
          platform: 'web',
        },
      },
    },
    {
      'cordis.patch.yml':
        "- insert:\n    - id: native-dsh-consumer\n      name: '@wework-e2e/native-dsh-consumer'\n",
      'index.js': `export const inject = ['nativeServerProvider']
export function apply(ctx) {
  ctx.nativeServerProvider.register({ id: 'native-dsh-consumer:fixture' })
}
`,
      'client.js': `window.__ModuleLoader__.load({
  id: '@wework-e2e/native-dsh-consumer',
  factory: () => {
    document.body.setAttribute('data-native-dsh-consumer-loaded', '')
    return {
      inject: ['nativeExtensionHost'],
      apply(ctx) {
        ctx.nativeExtensionHost.registerExtension({ id: 'native-dsh-consumer:fixture' })
        document.body.setAttribute('data-native-dsh-consumer-active', '')
        ctx.effect(
          () => () => document.body.removeAttribute('data-native-dsh-consumer-active'),
          'release E2E native DSH consumer marker'
        )
      },
    }
  },
})
`,
    }
  )
}

async function assertReleasePackageResources() {
  if (process.env.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE !== '1') return
  const appBinary = resolve(process.env.WEWORK_E2E_APP_BIN ?? '')
  assert.match(
    appBinary,
    /release-installer/,
    `Release startup E2E was not given a formal release binary: ${appBinary}`
  )
  const resourcesRoot =
    process.platform === 'darwin'
      ? resolve(appBinary, '..', '..', 'Resources')
      : resolve(appBinary, '..', 'resources')
  const [components] = await Promise.all([
    readFile(join(resourcesRoot, 'components.json'), 'utf8').then(JSON.parse),
    readFile(join(resourcesRoot, 'harness-runtime', 'runtimes.json')),
    readFile(join(resourcesRoot, 'codex', 'WEGENT_CODEX_BINARY.json')),
    readFile(join(resourcesRoot, 'wework-core-plugins', 'wework-app', 'package.json')),
    readFile(join(resourcesRoot, 'wework-app-static', 'wasm', 'data', 'sql-wasm.wasm')),
    readFile(
      join(
        resourcesRoot,
        'bundled-plugins',
        'wework-personal',
        '.claude-plugin',
        'marketplace.json'
      )
    ),
    readFile(
      join(
        resourcesRoot,
        'bin',
        process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
      )
    ),
    readFile(join(resourcesRoot, 'bin', process.platform === 'win32' ? 'dws.exe' : 'dws')),
  ])
  assert.deepEqual(Object.keys(components.components).sort(), [
    'bundledPlugins',
    'codex',
    'coreDsh',
    'dws',
    'electron',
    'executor',
    'weworkAppStatic',
    'weworkCorePlugins',
  ])
  for (const component of Object.values(components.components)) {
    assert.equal(typeof component.version, 'string')
    if ('path' in component) assert.match(component.sha256, /^[0-9a-f]{64}$/)
  }
  const codexRoot = join(resourcesRoot, components.components.codex.path)
  const codexRuntime = JSON.parse(
    await readFile(join(codexRoot, 'WEGENT_CODEX_BINARY.json'), 'utf8')
  )
  const codexBinary = join(codexRoot, codexRuntime.binaryPath)
  await Promise.all([
    readFile(codexBinary),
    readFile(
      join(
        dirname(codexBinary),
        process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
      )
    ),
  ])
}

export async function createDesktopScenario({
  electronUserDataDirectory,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  await assertReleasePackageResources()
  await seedTauriProfile(electronUserDataDirectory)
  const profileManifest = join(
    electronUserDataDirectory,
    'dsh-core',
    'profiles',
    PROFILE_NAME,
    'package.json'
  )

  return {
    usesReleasePackageRuntimeAssets: true,

    async verify(control) {
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await verifyEmbeddedNodeSkillRuntime(electronUserDataDirectory, resultDir)
      await control.command('waitFor', 'body[data-native-dsh-provider-loaded]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', 'body[data-native-dsh-provider-active]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', 'body[data-native-dsh-consumer-active]', {
        timeoutMs: uiTimeoutMs,
      })

      const manifest = JSON.parse(await readFile(profileManifest, 'utf8'))
      assert.equal(
        manifest.dependencies[NATIVE_PROVIDER],
        '2.1.0',
        'Wework did not recover the installed native DSH provider'
      )
      assert.equal(
        manifest.dependencies[NATIVE_CONSUMER],
        'file:./fixtures/native-dsh-consumer',
        'Wework removed the native DSH consumer'
      )
      assert.ok(manifest.dsh.profile.bundles.includes(NATIVE_PROVIDER))
      assert.ok(manifest.dsh.profile.bundles.includes(NATIVE_CONSUMER))
      assert.ok(
        manifest.dsh.profile.bundles.indexOf(NATIVE_PROVIDER) <
          manifest.dsh.profile.bundles.indexOf(NATIVE_CONSUMER),
        'The native DSH provider must activate before its consumer'
      )

      const appLog = await readFile(join(resultDir, 'app.log'), 'utf8')
      assert.doesNotMatch(appLog, /pending \(waiting for service: nativeExtensionHost\)/)
      assert.doesNotMatch(appLog, /Failed to load plugins/)
    },

    diagnostics() {
      return {
        nativeDshPluginCompatibility: true,
        seededTauriProfile: true,
      }
    },
  }
}

async function verifyEmbeddedNodeSkillRuntime(userDataDirectory, resultDir) {
  const binDirectory = join(userDataDirectory, 'managed-runtimes', 'electron-node', 'bin')
  const skillScript = join(resultDir, 'embedded-node-skill.ts')
  await writeFile(
    skillScript,
    'const runtime: string = `electron-node:${process.versions.node}`\nconsole.log(runtime)\n'
  )
  const output = await runNodeSkill(skillScript, binDirectory)
  assert.match(
    output,
    /^electron-node:\d+\.\d+\.\d+$/m,
    'A Codex skill TypeScript script did not run through Electron embedded Node'
  )
}

function runNodeSkill(script, binDirectory) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', [script], {
      env: {
        ...process.env,
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ''}`,
      },
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise(stdout.trim())
      else reject(new Error(`Embedded Node skill script failed (${code}): ${stderr.trim()}`))
    })
  })
}
