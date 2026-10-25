import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { watchDevelopmentBuild } from './lib/development-build-watch.mjs'
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

let completedBuilds = 0
const watcher = await watchDevelopmentBuild({
  directories: ['src', 'dsh', 'vite', 'public', 'wecode']
    .map(directory => path.join(weworkRoot, directory))
    .concat(path.join(weworkRoot, '..', 'packages')),
  files: [
    'vite.config.ts',
    'index.html',
    'package.json',
    'tsconfig.json',
    'tailwind.config.js',
    'postcss.config.js',
  ].map(file => path.join(weworkRoot, file)),
  ignored: [appWebRoot],
  build: async () => {
    // A fresh Vite instance owns each generation's CSS and emitted asset references.
    await build({
      root: weworkRoot,
      configFile: path.join(weworkRoot, 'vite.config.ts'),
      logLevel: 'warn',
      build: {
        outDir: appWebRoot,
        // Existing renderers may still request the previous generation's hashed assets.
        emptyOutDir: false,
      },
    })
    await normalizeBuildMetadata(appWebRoot)
    completedBuilds += 1
    await writeFile(buildIdFile, `${Date.now()}-${completedBuilds}\n`)
    await writeFile(readyFile, `${completedBuilds}\n`)
    console.log(`[wework-app-watch] built original Wework app (${completedBuilds})`)
  },
  onError: fail,
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
}
