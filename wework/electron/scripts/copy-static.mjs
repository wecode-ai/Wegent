import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(resolve(root, 'dist/runtime'), { recursive: true })
await cp(
  resolve(root, 'src/runtime/legacy-release-layout.mjs'),
  resolve(root, 'dist/runtime/legacy-release-layout.mjs')
)
await cp(
  resolve(root, 'src/runtime/legacy-dsh-browser-auth.cjs'),
  resolve(root, 'dist/runtime/legacy-dsh-browser-auth.cjs')
)
await cp(
  resolve(root, 'src/runtime/upgrade-policy.mjs'),
  resolve(root, 'dist/runtime/upgrade-policy.mjs')
)
await cp(
  resolve(root, 'src/runtime/release-preparation-progress.mjs'),
  resolve(root, 'dist/runtime/release-preparation-progress.mjs')
)
await cp(
  resolve(root, 'src/runtime/installed-preparation-contract.mjs'),
  resolve(root, 'dist/runtime/installed-preparation-contract.mjs')
)
await mkdir(resolve(root, 'dist/shell'), { recursive: true })
await cp(resolve(root, 'src/shell'), resolve(root, 'dist/shell'), {
  recursive: true,
})
await mkdir(resolve(root, 'dist/host/browser-runtime'), { recursive: true })
await cp(
  resolve(root, 'src/host/macos-quit-workaround.mjs'),
  resolve(root, 'dist/host/macos-quit-workaround.mjs')
)
await cp(
  resolve(root, 'src/host/browser-runtime/embedded_browser_inspect.js'),
  resolve(root, 'dist/host/browser-runtime/embedded_browser_inspect.js')
)
await cp(
  resolve(root, 'src/host/browser-runtime/embedded_browser_action.js'),
  resolve(root, 'dist/host/browser-runtime/embedded_browser_action.js')
)
await cp(
  resolve(root, 'src/host/browser-runtime/embedded_browser_wait.js'),
  resolve(root, 'dist/host/browser-runtime/embedded_browser_wait.js')
)
await mkdir(resolve(root, 'dist/cli'), { recursive: true })
await cp(resolve(root, 'src/cli/wework-cli.mjs'), resolve(root, 'dist/cli/wework-cli.mjs'))
const internalSurfaceManifest = resolve(root, '../wecode/electron/isolated-surfaces.json')
const packagedSurfaceManifest = resolve(root, 'dist/isolated-surfaces.json')
await rm(packagedSurfaceManifest, { force: true })
if (existsSync(internalSurfaceManifest)) {
  await cp(internalSurfaceManifest, packagedSurfaceManifest)
}
