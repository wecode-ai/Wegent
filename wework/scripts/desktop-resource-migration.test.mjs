import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const weworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const legacyRustDesktopDirectory = ['src', ['t', 'a', 'u', 'r', 'i'].join('')].join('-')
const scripts = [
  'scripts/dev-executor-sidecar.cmd',
  'electron/scripts/copy-static.mjs',
  'electron/scripts/package-app.mjs',
  'electron/scripts/prepare-package-assets.mjs',
  'scripts/dev-mac-app.sh',
  'scripts/dev-windows-app.ps1',
  'scripts/build-ai-verify-electron.mjs',
  'scripts/prepare-dev-component-resources.mjs',
  'scripts/prepare-dev-dependencies.mjs',
  'scripts/prepare-ai-verify-electron.mjs',
  'scripts/prepare-codex-binary.mjs',
  'scripts/prepare-dws-binary.mjs',
  'scripts/prepare-electron.mjs',
  'scripts/prepare-harness-runtime.mjs',
]

describe('desktop resource migration', () => {
  test('desktop entrypoints install the isolated Electron workspace', async () => {
    const packageJson = JSON.parse(await readFile(join(weworkRoot, 'package.json'), 'utf8'))
    const devMacScript = await readFile(join(weworkRoot, 'scripts/dev-mac-app.sh'), 'utf8')
    const devWindowsScript = await readFile(join(weworkRoot, 'scripts/dev-windows-app.ps1'), 'utf8')
    const devAppWatcher = await readFile(
      join(weworkRoot, 'scripts/dev-wework-app-watch.mjs'),
      'utf8'
    )
    const aiVerifyBuildScript = await readFile(
      join(weworkRoot, 'scripts/build-ai-verify-electron.mjs'),
      'utf8'
    )
    const viteConfig = await readFile(join(weworkRoot, 'vite.config.ts'), 'utf8')

    expect(packageJson.scripts['prepare:electron']).toBe('node scripts/prepare-electron.mjs')
    expect(packageJson.scripts['dev:desktop']).toContain('pnpm run prepare:electron')
    expect(packageJson.scripts['dev:mac']).toBe('bash scripts/dev-mac-app.sh')
    expect(packageJson.scripts['dev:windows']).toContain('scripts/dev-windows-app.ps1')
    expect(packageJson.scripts['ai:verify:electron:prepare']).toBe(
      'node scripts/prepare-ai-verify-electron.mjs'
    )
    expect(packageJson.scripts['ai:verify:electron:build']).toBe(
      'node scripts/build-ai-verify-electron.mjs'
    )
    expect(
      Object.entries(packageJson.scripts)
        .filter(([name]) => name.startsWith('e2e:desktop'))
        .map(([, command]) => command)
    ).toEqual([
      'node e2e/desktop/run-checkpoints.mjs',
      'node e2e/desktop/run-checkpoints.mjs --cloud-only',
      'node e2e/desktop/run-checkpoints.mjs --cloud-features-only',
      'node e2e/desktop/run-checkpoints.mjs --cloud-vision-only',
      'node e2e/desktop/run-checkpoints.mjs --plugins-only',
      'node e2e/desktop/run-checkpoints.mjs --memory-only',
      'node e2e/desktop/run-checkpoints.mjs --segment embedded-browser',
      'node e2e/desktop/run-checkpoints.mjs --segment browser-toolbar-actions',
      'node e2e/desktop/run-checkpoints.mjs --segment local-harness',
      'node e2e/desktop/run-checkpoints.mjs --segment rendering-extensions',
    ])
    expect(packageJson.scripts['build:release']).toBe(
      'pnpm run prepare:electron && pnpm --dir electron build:release'
    )
    expect(aiVerifyBuildScript).toContain("['run', 'prepare:electron']")
    expect(aiVerifyBuildScript).toContain("['run', 'prepare:codex', '--materialize']")
    expect(aiVerifyBuildScript).toContain("['run', 'prepare:dws']")
    expect(aiVerifyBuildScript).toContain("['--dir', 'electron', 'run', 'build:package']")
    expect(aiVerifyBuildScript).toContain('resolveHarnessRuntimeAssetCacheEnvironment(')
    expect(aiVerifyBuildScript).toContain('isolateAiVerifyRuntimeEnvironment(process.env)')
    expect(aiVerifyBuildScript).toContain("process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'")
    expect(aiVerifyBuildScript).toContain('wrapWindowsScriptCommand(command, args)')
    expect(devMacScript).toContain('WEWORK_USER_DATA_DIR=')
    expect(devMacScript).toContain('io.wecode.wework.dev/$WEWORK_DEV_INSTANCE_ID')
    expect(aiVerifyBuildScript).not.toContain("['run', 'build:dsh-app']")
    expect(packageJson.scripts['build:dsh-app']).toBe(
      'vite build --base /wework/app/ --outDir dsh/app-wework/web --emptyOutDir'
    )
    expect(devAppWatcher).toContain('outDir: appWebRoot')
    expect(devAppWatcher).toContain('emptyOutDir: true')
    expect(devAppWatcher).not.toContain('WEWORK_DSH_APP_OUT_DIR')
    expect(viteConfig).not.toContain('WEWORK_DSH_APP_OUT_DIR')
    expect(devMacScript).not.toContain('node electron/node_modules/electron/install.js')
    expect(devMacScript).not.toContain('pnpm --dir electron prepare:package')
    expect(devWindowsScript).not.toContain('node electron/node_modules/electron/install.js')
  })

  test.each(scripts)('%s depends only on neutral desktop resources', async relativePath => {
    const source = await readFile(join(weworkRoot, relativePath), 'utf8')

    expect(source).not.toContain(legacyRustDesktopDirectory)
  })

  test('packages production dependencies from the locked Electron workspace', async () => {
    const source = await readFile(join(weworkRoot, 'electron/scripts/package-app.mjs'), 'utf8')

    expect(source).toContain("'--config.inject-workspace-packages=true'")
    expect(source).toContain("'--config.node-linker=hoisted'")
    expect(source).toContain("'deploy',")
    expect(source).toContain("'--prod',")
    expect(source).toContain("process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'")
    expect(source).toContain('wrapWindowsScriptCommand(command, args)')
    expect(source).not.toContain("'--legacy'")
    expect(source).not.toContain("'npm',")
    expect(source).not.toContain("'install', '--omit=dev'")
  })

  test('serializes Electron installation and packaging across worktrees', async () => {
    const [prepareElectron, packageApp] = await Promise.all([
      readFile(join(weworkRoot, 'scripts/prepare-electron.mjs'), 'utf8'),
      readFile(join(weworkRoot, 'electron/scripts/package-app.mjs'), 'utf8'),
    ])

    expect(prepareElectron).toContain('acquireProcessLock(electronToolchainLockPath)')
    expect(packageApp).toContain('acquireProcessLock(electronToolchainLockPath)')
    expect(prepareElectron).toContain("['--dir', 'electron', 'install', '--frozen-lockfile']")
    expect(packageApp).toContain('await releaseToolchainLock()')
  })

  test('reuses an unchanged prepared DWS sidecar', async () => {
    const source = await readFile(join(weworkRoot, 'scripts/prepare-dws-binary.mjs'), 'utf8')

    expect(source).toContain('preparedBinaryIsCurrent')
    expect(source).toContain('Reusing prepared DWS sidecar')
  })

  test('packages CUA native libraries and license outside ASAR', async () => {
    const [packageApp, builderConfig, electronWorkspace, asarPatch, license] = await Promise.all([
      readFile(join(weworkRoot, 'electron/scripts/package-app.mjs'), 'utf8'),
      readFile(join(weworkRoot, 'electron/electron-builder.config.cjs'), 'utf8'),
      readFile(join(weworkRoot, 'electron/pnpm-workspace.yaml'), 'utf8'),
      readFile(join(weworkRoot, 'electron/patches/@trycua__cua-driver@0.22.1.patch'), 'utf8'),
      readFile(join(weworkRoot, 'resources/licenses/cua-driver-LICENSE.md'), 'utf8'),
    ])

    expect(packageApp).toContain("unpack: '**/*.{node,dylib,so,dll}'")
    expect(packageApp).toContain("join(sharedResourcesRoot, 'licenses')")
    expect(builderConfig).toContain("asarUnpack: ['**/*.{node,dylib,so,dll}']")
    expect(builderConfig).toContain("{ from: '../resources/licenses', to: 'licenses' }")
    expect(electronWorkspace).toContain("'@trycua/cua-driver@0.22.1':")
    expect(asarPatch).toContain('app.asar.unpacked')
    expect(license).toContain('Copyright (c) 2025 Cua AI, Inc.')
  })

  test('defaults packaged executors to release with an explicit debug E2E profile', async () => {
    const [source, harnessRuntimeSource] = await Promise.all([
      readFile(join(weworkRoot, 'electron/scripts/prepare-package-assets.mjs'), 'utf8'),
      readFile(join(weworkRoot, 'scripts/prepare-harness-runtime.mjs'), 'utf8'),
    ])

    expect(source).toContain("process.env.WEWORK_EXECUTOR_PROFILE?.trim() || 'release'")
    expect(source).toContain("configured === 'debug' || configured === 'release'")
    expect(source).toContain("profile === 'release' ? ['--release'] : []")
    expect(source).toContain('const [executorPath] = await Promise.all([')
    expect(source).toContain("process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'")
    expect(source).toContain("run(pnpmCommand, ['prepare:codex', '--materialize']")
    expect(source).toContain("run(pnpmCommand, ['prepare:dws']")
    expect(source).toContain("['prepare:harness-runtime', '--materialize']")
    expect(source).toContain('resolveHarnessRuntimeCachePaths(')
    expect(source).toContain('join(harnessRuntimeAssetDirectory, runtime.assetName)')
    expect(source).not.toContain(
      "join(weworkRoot, 'node_modules', '.cache', 'harness-runtime-assets'"
    )
    expect(source).toContain('resolveDesktopPackageTargets(process.env)')
    expect(source).toContain('WEWORK_CODEX_TARGET: packageTargets.codexTarget')
    expect(source).toContain('WEWORK_DWS_TARGET: packageTargets.dwsTarget')
    expect(source).toContain("path: 'bundled-plugins'")
    expect(source).toContain('const weworkRuntimeVersion = `wework-${sourceSha.slice(0, 12)}`')
    expect(source).toContain('version: weworkRuntimeVersion')
    expect(source).toContain('sourceSha,')
    expect(source).toContain('path: `bin/${dwsName}`')
    expect(source).toContain("version: weworkPackage.devDependencies['dingtalk-workspace-cli']")
    expect(source).not.toContain('prepare:execution-runtime')
    expect(source).not.toContain('execution-runtime-node-dev')
    expect(source).toContain('wrapWindowsScriptCommand(command, args)')
    expect(harnessRuntimeSource).toContain("import { create, extract } from 'tar'")
    expect(harnessRuntimeSource).toContain('await extract({')
    expect(harnessRuntimeSource).toContain('await create(')
    expect(harnessRuntimeSource).not.toContain("run('tar'")
  })

  test('does not include a separate Node runtime in desktop packages', async () => {
    const [packageApp, builderConfig] = await Promise.all([
      readFile(join(weworkRoot, 'electron/scripts/package-app.mjs'), 'utf8'),
      readFile(join(weworkRoot, 'electron/electron-builder.config.cjs'), 'utf8'),
    ])

    expect(packageApp).not.toContain("resources', 'node-runtime")
    expect(builderConfig).not.toContain('resources/node-runtime')
  })

  test('launches the release builder through the Windows command interpreter', async () => {
    const source = await readFile(join(weworkRoot, 'electron/scripts/build-release.mjs'), 'utf8')

    expect(source).toContain("process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'")
    expect(source).toContain('wrapWindowsScriptCommand(command, args)')
  })

  test('collects the electron-builder Linux x64 artifact name', async () => {
    const source = await readFile(
      join(weworkRoot, 'scripts/prepare-desktop-release-assets.mjs'),
      'utf8'
    )

    expect(source).toContain(
      "const installerArchitecture = platform === 'linux' && arch === 'x64' ? 'x86_64' : arch"
    )
    expect(source).toContain('linux_${installerArchitecture}\\\\.AppImage')
  })

  test('creates macOS component archives from the requested packaged application', async () => {
    const source = await readFile(
      join(weworkRoot, 'scripts/prepare-desktop-release-assets.mjs'),
      'utf8'
    )

    expect(source).toContain("arch === 'arm64' ? 'mac-arm64' : 'mac'")
    expect(source).toContain(
      "packagedComponentResourcesRoot = join(appPath, 'Contents', 'Resources')"
    )
    expect(source).toContain("join(packagedComponentResourcesRoot, 'components.json')")
    expect(source).toContain('join(packagedComponentResourcesRoot, component.path)')
    expect(source).not.toContain('async function findDirectory')
  })

  test('requires differential update blockmaps in formal release assets', async () => {
    const source = await readFile(
      join(weworkRoot, 'scripts/prepare-desktop-release-assets.mjs'),
      'utf8'
    )

    expect(source).toContain('const blockmap = `${zip}.blockmap`')
    expect(source).toContain('const blockmap = `${installer}.blockmap`')
    expect(source).toContain('await requireFile(blockmap)')
    expect(source).not.toContain('if (await isFile(blockmap))')
  })

  test('signs legacy updater assets through the Windows command interpreter', async () => {
    const source = await readFile(
      join(weworkRoot, 'scripts/prepare-desktop-release-assets.mjs'),
      'utf8'
    )

    expect(source).toContain("process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'")
    expect(source).toContain('wrapWindowsScriptCommand(command, args)')
  })

  test('desktop E2E reuses packaged Harness runtime assets', async () => {
    const source = await readFile(
      join(weworkRoot, 'e2e/desktop/modules/desktop-build-flows.mjs'),
      'utf8'
    )

    expect(source).toContain('const packagedResourcesRoot = join(')
    expect(source).toContain(
      "const packagedResources = join(packagedResourcesRoot, 'harness-runtime')"
    )
    expect(source).toContain("corePluginsRoot: join(packagedResourcesRoot, 'wework-core-plugins')")
    expect(source).toContain('harnessRuntimeRoot: runtimeRoot')
    expect(source).not.toContain("['prepare:harness-runtime', '--materialize']")
  })

  test('prepares AI verification source mode without packaged Node resources', async () => {
    const source = await readFile(
      join(weworkRoot, 'scripts/prepare-ai-verify-electron.mjs'),
      'utf8'
    )

    expect(source).not.toContain('prepare:execution-runtime')
    expect(source).not.toContain('electronInstallScript')
    expect(source).not.toContain("['run', 'prepare:codex']")
    expect(source).not.toContain("['run', 'prepare:dws']")
    expect(source).toContain("['--dir', 'electron', 'run', 'prepare:package']")
    expect(source).toContain('WEWORK_EXECUTOR_PATH: executorPath')
  })

  test.each([
    'resources/icons/icon.icns',
    'resources/icons/icon.ico',
    'resources/bundled-harness-runtime/.resource-placeholder',
    'resources/bundled-plugins/wework-personal/.agents/plugins/marketplace.json',
    'resources/bundled-plugins/wework-plugin-example/.codex-plugin/plugin.json',
    'electron/src/host/browser-runtime/embedded_browser_action.js',
    'electron/src/host/browser-runtime/embedded_browser_inspect.js',
    'electron/src/host/browser-runtime/embedded_browser_wait.js',
  ])('%s exists in its neutral resource location', async relativePath => {
    await expect(access(join(weworkRoot, relativePath))).resolves.toBeUndefined()
  })
})
