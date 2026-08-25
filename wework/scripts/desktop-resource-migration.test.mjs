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
  'scripts/prepare-codex-binary.mjs',
  'scripts/prepare-dws-binary.mjs',
  'scripts/prepare-execution-runtime.mjs',
  'scripts/prepare-harness-runtime.mjs',
]

describe('desktop resource migration', () => {
  test('desktop entrypoints install the isolated Electron workspace', async () => {
    const packageJson = JSON.parse(await readFile(join(weworkRoot, 'package.json'), 'utf8'))

    expect(packageJson.scripts['prepare:electron']).toBe(
      'pnpm --dir electron install --frozen-lockfile'
    )
    expect(packageJson.scripts['dev:desktop']).toContain('pnpm run prepare:electron')
    expect(packageJson.scripts['ai:verify:electron:build']).toContain('pnpm run prepare:electron')
  })

  test.each(scripts)('%s depends only on neutral desktop resources', async relativePath => {
    const source = await readFile(join(weworkRoot, relativePath), 'utf8')

    expect(source).not.toContain(legacyRustDesktopDirectory)
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
