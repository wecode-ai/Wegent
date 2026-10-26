import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
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

async function seedNativeDshProfile(userDataDirectory) {
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
          inject: ['@deepseek-ai/dsh-client-ui-renderer'],
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
          inject: ['@deepseek-ai/dsh-client-ui-renderer'],
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
  const appBinary = resolve(process.env.WEWORK_E2E_APP_BIN ?? '')
  const resourcesRoot =
    process.platform === 'darwin'
      ? resolve(appBinary, '..', '..', 'Resources')
      : resolve(appBinary, '..', 'resources')
  const components = JSON.parse(await readFile(join(resourcesRoot, 'components.json'), 'utf8'))
  const catalog = JSON.parse(
    await readFile(join(resourcesRoot, 'harness-runtime', 'runtimes.json'), 'utf8')
  )
  const currentRuntimes = catalog.runtimes.filter(runtime => runtime.dshVersion === '0.2.0-rc.2')
  assert.deepEqual(currentRuntimes.map(runtime => runtime.role).sort(), ['core', 'workbench'])
  assert.equal(new Set(currentRuntimes.map(runtime => runtime.sourceFingerprint)).size, 1)
  assert.equal(new Set(currentRuntimes.map(runtime => runtime.assetName)).size, 1)
  assert.equal(new Set(currentRuntimes.map(runtime => runtime.archiveSha256)).size, 1)
  assert.equal(new Set(currentRuntimes.map(runtime => runtime.archiveBytes)).size, 1)
  assert.deepEqual(catalog.runtimes, currentRuntimes)
  const legacy = catalog.downloadableRuntimes.find(
    runtime => runtime.role === 'workbench' && runtime.dshVersion === '0.1.0-rc.8'
  )
  assert.ok(legacy, 'The packaged catalog must retain the legacy Smart app download descriptor')
  await assert.rejects(lstat(join(resourcesRoot, 'harness-runtime', legacy.assetName)), {
    code: 'ENOENT',
  })
  assert.match(
    components.sourceSha,
    /^[0-9a-f]{40,64}$/i,
    'The packaged component manifest must identify its source commit'
  )

  if (process.env.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE !== '1') {
    return components
  }
  assert.match(
    appBinary,
    /release-installer/,
    `Release startup E2E was not given a formal release binary: ${appBinary}`
  )
  if (process.platform === 'darwin') await assertMacosMicrophoneSigning(appBinary)
  await Promise.all([
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
  return components
}

async function assertMacosMicrophoneSigning(appBinary) {
  const appRoot = resolve(appBinary, '..', '..', '..')
  const frameworksRoot = join(appRoot, 'Contents', 'Frameworks')
  const helpers = (await readdir(frameworksRoot)).filter(name => name.endsWith('.app'))
  assert.ok(helpers.length > 0, 'The release package must contain Electron helpers')

  for (const bundle of [appRoot, ...helpers.map(name => join(frameworksRoot, name))]) {
    execFileSync('codesign', ['--verify', '--strict', bundle], { stdio: 'pipe' })
    const entitlements = execFileSync('codesign', ['--display', '--entitlements', ':-', bundle], {
      stdio: 'pipe',
    })
    const plist = JSON.parse(
      execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], {
        input: entitlements,
        encoding: 'utf8',
      })
    )
    assert.equal(
      plist['com.apple.security.device.audio-input'],
      true,
      `Microphone audio-input entitlement is missing from ${bundle}`
    )
  }

  const description = execFileSync(
    'plutil',
    ['-extract', 'NSMicrophoneUsageDescription', 'raw', join(appRoot, 'Contents', 'Info.plist')],
    { encoding: 'utf8' }
  )
  assert.ok(description.trim(), 'The release package must explain microphone access')
}

async function assertCompressedHostUpdatePackage(appVersion) {
  if (process.env.WEWORK_E2E_REQUIRE_COMPRESSED_HOST_UPDATE !== 'true') return null
  assert.equal(process.platform, 'darwin', 'Compressed Host update verification requires macOS')

  const appBinary = resolve(process.env.WEWORK_E2E_APP_BIN ?? '')
  const appRoot = resolve(appBinary, '..', '..', '..')
  const installerRoot = resolve(appRoot, '..', '..')
  const onlineUpdateRoot = resolve(installerRoot, '..', 'release-online-update')
  const archiveName = `WeWorkHostUpdate_${appVersion}_macos_${process.arch}.zip`
  const archivePath = join(onlineUpdateRoot, archiveName)
  const summary = execFileSync('zipinfo', ['-l', archivePath], { encoding: 'utf8' })
  const match = /(\d+) files, (\d+) bytes uncompressed, (\d+) bytes compressed:\s*([\d.]+)%/.exec(
    summary
  )
  assert.ok(match, `Could not read compression summary for ${archiveName}`)

  const uncompressedBytes = Number(match[2])
  const compressedBytes = Number(match[3])
  assert.ok(uncompressedBytes > 0, `The Host update archive is empty: ${archiveName}`)
  assert.ok(
    compressedBytes < uncompressedBytes,
    `The Host update archive is not compressed: ${compressedBytes} of ${uncompressedBytes} bytes`
  )
  return {
    archiveName,
    entries: Number(match[1]),
    uncompressedBytes,
    compressedBytes,
    savingsPercent: Number(match[4]),
  }
}

export async function createDesktopScenario({
  electronUserDataDirectory,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  const packagedComponents = await assertReleasePackageResources()
  const hostUpdateCompression = await assertCompressedHostUpdatePackage(
    packagedComponents.appVersion
  )
  if (hostUpdateCompression) {
    await writeFile(
      join(resultDir, 'host-update-compression.json'),
      `${JSON.stringify(hostUpdateCompression, null, 2)}\n`
    )
  }
  await seedNativeDshProfile(electronUserDataDirectory)
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
      await control.command('navigate', 'body', { value: '/settings/about' })
      await control.command('waitFor', '[data-testid="about-commit-id"]', {
        timeoutMs: uiTimeoutMs,
      })
      const displayedCommit = (
        await control.command('getText', '[data-testid="about-commit-id"]')
      ).trim()
      const fullCommit = await control.command('getAttribute', '[data-testid="about-commit-id"]', {
        value: 'title',
      })
      assert.ok(
        displayedCommit.endsWith(packagedComponents.sourceSha.slice(0, 12)),
        `About displayed ${displayedCommit} instead of packaged commit ${packagedComponents.sourceSha}`
      )
      assert.equal(
        fullCommit,
        packagedComponents.sourceSha.toLowerCase(),
        'About did not expose the complete packaged source commit'
      )
      await writeFile(
        join(resultDir, 'about-build-identity.json'),
        `${JSON.stringify(
          {
            displayedCommit,
            fullCommit,
            packagedSourceSha: packagedComponents.sourceSha,
          },
          null,
          2
        )}\n`
      )
      await verifyWindowsProfileOwnedAssets(electronUserDataDirectory)
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
        seededNativeDshProfile: true,
        hostUpdateCompression,
      }
    },
  }
}

async function verifyWindowsProfileOwnedAssets(userDataDirectory) {
  if (process.platform !== 'win32') return
  const assets = join(
    userDataDirectory,
    'dsh-core',
    'profiles',
    PROFILE_NAME,
    'node_modules',
    '@wegent',
    'dsh-app-wework',
    'web',
    'assets'
  )
  const metadata = await lstat(assets)
  assert.equal(metadata.isDirectory(), true, 'Windows Core DSH profile assets must be a directory')
  assert.equal(
    metadata.isSymbolicLink(),
    false,
    'Windows Core DSH profile assets must own their files so pnpm cannot delete shared resources'
  )
  assert.ok((await readdir(assets)).length > 0, 'Windows Core DSH profile assets must not be empty')
}

export async function verifyEmbeddedNodeSkillRuntime(userDataDirectory, resultDir) {
  const binDirectory = join(userDataDirectory, 'runtime', 'bin')
  const launcher = join(binDirectory, process.platform === 'win32' ? 'node.cmd' : 'node')
  assert.ok((await lstat(launcher)).isFile(), 'The packaged Node launcher must exist')
  const skillScript = join(resultDir, 'embedded-node-skill.ts')
  await writeFile(
    skillScript,
    'const runtime: NodeJS.ProcessVersions = process.versions\nconsole.log(JSON.stringify({ node: runtime.node, electron: runtime.electron, availableMemoryBytes: process.availableMemory() }))\n'
  )
  const output = await runNodeSkill(skillScript, binDirectory)
  const runtime = JSON.parse(output)
  const electronPackage = JSON.parse(
    await readFile(new URL('../../../electron/package.json', import.meta.url), 'utf8')
  )
  // DSH's native loader accepts exact Electron fingerprints, not an entire major range.
  assert.equal(runtime.electron, electronPackage.devDependencies.electron)
  assert.match(runtime.electron, /^43\./, 'The release package must support Electron 43')
  assert.ok(Number.isFinite(runtime.availableMemoryBytes) && runtime.availableMemoryBytes >= 0)
  assert.match(
    runtime.node,
    /^\d+\.\d+\.\d+$/,
    'A Codex skill TypeScript script did not run through Electron embedded Node'
  )
  await writeFile(join(resultDir, 'embedded-node-versions.json'), `${JSON.stringify(runtime)}\n`)
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
