import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const weworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const legacyRustDesktopDirectory = ['src', ['t', 'a', 'u', 'r', 'i'].join('')].join('-')
const scripts = [
  'electron/scripts/copy-static.mjs',
  'electron/scripts/package-app.mjs',
  'electron/scripts/prepare-package-assets.mjs',
  'scripts/dev-mac-app.sh',
  'scripts/prepare-ai-verify-electron.mjs',
  'scripts/prepare-codex-binary.mjs',
  'scripts/prepare-dws-binary.mjs',
  'scripts/prepare-execution-runtime.mjs',
  'scripts/prepare-harness-runtime.mjs',
]

describe('desktop resource migration', () => {
  test('desktop entrypoints install the isolated Electron workspace', async () => {
    const packageJson = JSON.parse(await readFile(join(weworkRoot, 'package.json'), 'utf8'))
    const devMacScript = await readFile(join(weworkRoot, 'scripts/dev-mac-app.sh'), 'utf8')

    expect(packageJson.scripts['prepare:electron']).toBe(
      'pnpm --dir electron install --frozen-lockfile'
    )
    expect(packageJson.scripts['dev:desktop']).toContain('pnpm run prepare:electron')
    expect(packageJson.scripts['dev:mac']).toBe('bash scripts/dev-mac-app.sh')
    expect(packageJson.scripts['ai:verify:electron:prepare']).toBe(
      'node scripts/prepare-ai-verify-electron.mjs'
    )
    expect(packageJson.scripts['ai:verify:electron:build']).toContain('pnpm run prepare:electron')
    expect(devMacScript).toContain('WEWORK_USER_DATA_DIR=')
    expect(devMacScript).toContain('io.wecode.wework.dev/$WEWORK_DEV_INSTANCE_ID')
    expect(packageJson.scripts['ai:verify:electron:build']).not.toContain('pnpm run build:dsh-app')
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
    expect(source).not.toContain("'--legacy'")
    expect(source).not.toContain("'npm',")
    expect(source).not.toContain("'install', '--omit=dev'")
  })

  test('defaults packaged executors to release with an explicit debug E2E profile', async () => {
    const source = await readFile(
      join(weworkRoot, 'electron/scripts/prepare-package-assets.mjs'),
      'utf8'
    )

    expect(source).toContain("process.env.WEWORK_EXECUTOR_PROFILE?.trim() || 'release'")
    expect(source).toContain("configured === 'debug' || configured === 'release'")
    expect(source).toContain("profile === 'release' ? ['--release'] : []")
    expect(source).toContain('const [executorPath] = await Promise.all([')
    expect(source).toContain("run('pnpm', ['prepare:harness-runtime', '--materialize']")
    expect(source).toContain("run('pnpm', ['prepare:execution-runtime', '--materialize']")
  })

  test('desktop E2E reuses packaged Harness runtime assets', async () => {
    const source = await readFile(
      join(weworkRoot, 'e2e/desktop/modules/desktop-build-flows.mjs'),
      'utf8'
    )

    expect(source).toContain('const packagedResources = join(')
    expect(source).toContain("['resources', 'harness-runtime']")
    expect(source).not.toContain("['prepare:harness-runtime', '--materialize']")
  })

  test('prepares AI verification source mode without packaged Node resources', async () => {
    const source = await readFile(
      join(weworkRoot, 'scripts/prepare-ai-verify-electron.mjs'),
      'utf8'
    )

    expect(source).not.toContain('prepare:execution-runtime')
  })

  test.each([
    'resources/icons/icon.icns',
    'resources/icons/icon.ico',
    'resources/bundled-execution-runtimes/node.json',
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
