import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { normalizeFileViewerAssetManifest } from './lib/harness-runtime-metadata.mjs'

const weworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appWebRoot = path.join(weworkRoot, 'dsh', 'app-wework', 'web')
const buildIdFile = path.join(appWebRoot, '.wework-build-id')
const readyFile = process.env.WEWORK_APP_WATCH_READY_FILE?.trim()

if (!readyFile) throw new Error('WEWORK_APP_WATCH_READY_FILE is required')

await rm(readyFile, { force: true })
await rm(appWebRoot, { recursive: true, force: true })

process.env.VITE_APP_BASE_PATH = '/wework/app/'
process.chdir(weworkRoot)

const watcher = await build({
  root: weworkRoot,
  configFile: path.join(weworkRoot, 'vite.config.ts'),
  logLevel: 'warn',
  build: {
    outDir: appWebRoot,
    // Keep the previous hashed assets available until the completed build id
    // is published. The running renderer may still request them while Vite is
    // writing the next generation.
    emptyOutDir: false,
    watch: {},
  },
})

if (!('on' in watcher)) {
  throw new Error('Vite did not create a Wework application build watcher')
}

let completedBuilds = 0
let finalizing = Promise.resolve()
let pendingResult = null

watcher.on('event', event => {
  if (event.code === 'BUNDLE_END') {
    pendingResult = event.result
    return
  }
  if (event.code === 'END') {
    const result = pendingResult
    pendingResult = null
    finalizing = finalizing
      .then(async () => {
        await result?.close()
        await normalizeBuildMetadata(appWebRoot)
        completedBuilds += 1
        await writeFile(buildIdFile, `${Date.now()}-${completedBuilds}\n`)
        await writeFile(readyFile, `${completedBuilds}\n`)
        console.log(`[wework-app-watch] built original Wework app (${completedBuilds})`)
      })
      .catch(fail)
    return
  }
  if (event.code === 'ERROR') {
    fail(event.error)
    if (completedBuilds === 0) {
      void watcher.close().finally(() => process.exit(1))
    }
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void watcher.close().finally(() => process.exit(0))
  })
}

async function normalizeBuildMetadata(root) {
  const manifestPath = path.join(root, 'flyfish-viewer-assets.json')
  let lastError
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      await writeFile(
        manifestPath,
        `${JSON.stringify(normalizeFileViewerAssetManifest(manifest, root), null, 2)}\n`
      )
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw lastError
}

function fail(error) {
  console.error(
    `[wework-app-watch] ${error instanceof Error ? (error.stack ?? error.message) : error}`
  )
  process.exitCode = 1
}
