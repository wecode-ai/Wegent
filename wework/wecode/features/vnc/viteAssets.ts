import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Connect, Plugin } from 'vite'

export interface VncAssetDefinition {
  readonly fileName: string
  readonly mime: string
}

export const VNC_ASSETS: readonly VncAssetDefinition[] = [
  {
    fileName: 'vnc.html',
    mime: 'text/html; charset=utf-8',
  },
  {
    fileName: 'novnc/rfb.min.js',
    mime: 'text/javascript; charset=utf-8',
  },
]

const defaultAssetsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'assets')

function normalizeBase(base: string): string {
  const pathname = new URL(base || '/', 'http://localhost').pathname
  const segments = pathname.split('/').filter(Boolean)
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`
}

export function matchVncAsset(
  requestUrl: string | undefined,
  base: string
): VncAssetDefinition | null {
  if (!requestUrl) return null

  let pathname: string
  try {
    pathname = new URL(requestUrl, 'http://localhost').pathname
  } catch {
    return null
  }

  const basePath = normalizeBase(base)
  return VNC_ASSETS.find(asset => pathname === `${basePath}${asset.fileName}`) ?? null
}

export function createVncAssetsMiddleware(
  base: string,
  assetsDirectory = defaultAssetsDirectory
): Connect.NextHandleFunction {
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
    } catch {
      next()
    }
  }
}

export function createVncAssetsPlugin(assetsDirectory = defaultAssetsDirectory): Plugin {
  let base = '/'

  return {
    name: 'wework-vnc-assets',
    configResolved(config) {
      base = config.base
    },
    configureServer(server) {
      server.middlewares.use(createVncAssetsMiddleware(base, assetsDirectory))
    },
    generateBundle() {
      for (const asset of VNC_ASSETS) {
        this.emitFile({
          type: 'asset',
          fileName: asset.fileName,
          source: readFileSync(resolve(assetsDirectory, asset.fileName)),
        })
      }
    },
  }
}
