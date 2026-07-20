import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @typedef {import('vite').Connect.NextHandleFunction} NextHandleFunction */
/** @typedef {import('vite').Plugin} Plugin */
/** @typedef {import('vite').ViteDevServer} ViteDevServer */

/**
 * @typedef {object} VncAssetDefinition
 * @property {string} fileName
 * @property {string} mime
 */

/** @type {readonly VncAssetDefinition[]} */
export const VNC_ASSETS = [
  {
    fileName: 'vnc.html',
    mime: 'text/html; charset=utf-8',
  },
  {
    fileName: 'novnc/rfb.min.js',
    mime: 'text/javascript; charset=utf-8',
  },
]

const defaultPluginModulePath = fileURLToPath(import.meta.url)
const defaultAssetsDirectory = resolve(dirname(defaultPluginModulePath), 'assets')

/**
 * @param {string} base
 * @returns {string}
 */
function normalizeBase(base) {
  const pathname = new URL(base || '/', 'http://localhost').pathname
  const segments = pathname.split('/').filter(Boolean)
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`
}

/**
 * @param {string | undefined} requestUrl
 * @param {string} base
 * @returns {VncAssetDefinition | null}
 */
export function matchVncAsset(requestUrl, base) {
  if (!requestUrl) return null

  let pathname
  try {
    pathname = new URL(requestUrl, 'http://localhost').pathname
  } catch {
    return null
  }

  const basePath = normalizeBase(base)
  return VNC_ASSETS.find(asset => pathname === `${basePath}${asset.fileName}`) ?? null
}

/**
 * @param {string} base
 * @param {string} [assetsDirectory]
 * @returns {NextHandleFunction}
 */
export function createVncAssetsMiddleware(base, assetsDirectory = defaultAssetsDirectory) {
  return (request, response, next) => {
    const asset = matchVncAsset(request.url, base)
    if (!asset) {
      next()
      return
    }

    try {
      const source = readFileSync(resolve(assetsDirectory, asset.fileName))
      response.statusCode = 200
      response.setHeader('Content-Type', asset.mime)
      response.end(source)
    } catch (error) {
      next(error)
    }
  }
}

/**
 * @param {ViteDevServer} server
 * @param {string} pluginModulePath
 * @returns {() => void}
 */
function watchPluginModule(server, pluginModulePath) {
  const watchedPluginPath = resolve(pluginModulePath)
  const watcher = server.watcher
  let restartInFlight = false

  const handleChange = async changedPath => {
    if (resolve(changedPath) !== watchedPluginPath || restartInFlight) return

    restartInFlight = true
    try {
      await server.restart()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      server.config.logger.error(`Failed to reload the VNC assets plugin: ${message}`, { error })
    } finally {
      restartInFlight = false
    }
  }

  watcher.add(watchedPluginPath)
  watcher.on('change', handleChange)
  return () => watcher.off('change', handleChange)
}

/**
 * @param {string} [assetsDirectory]
 * @param {string} [pluginModulePath]
 * @returns {Plugin}
 */
export function createVncAssetsPlugin(
  assetsDirectory = defaultAssetsDirectory,
  pluginModulePath = defaultPluginModulePath
) {
  let base = '/'
  let cleanupDevWatcher

  return {
    name: 'wework-vnc-assets',
    configResolved(config) {
      base = config.base
    },
    configureServer(server) {
      server.middlewares.use(createVncAssetsMiddleware(base, assetsDirectory))
      cleanupDevWatcher?.()
      cleanupDevWatcher = watchPluginModule(server, pluginModulePath)
    },
    closeBundle() {
      // Vite closes the dev plugin container on shutdown and before a successful restart.
      cleanupDevWatcher?.()
      cleanupDevWatcher = undefined
    },
    generateBundle() {
      for (const asset of VNC_ASSETS) {
        const sourcePath = resolve(assetsDirectory, asset.fileName)
        this.addWatchFile(sourcePath)
        this.emitFile({
          type: 'asset',
          fileName: asset.fileName,
          source: readFileSync(sourcePath),
        })
      }
    },
  }
}
