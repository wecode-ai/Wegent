import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin } from 'vite'

export function excalidrawAssets(): Plugin {
  const require = createRequire(import.meta.url)
  const fontsDirectory = path.join(path.dirname(require.resolve('@excalidraw/excalidraw')), 'fonts')
  const assets = new Map<string, Buffer>(
    readdirSync(fontsDirectory, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const filename = path.join(entry.parentPath, entry.name)
        const relative = path.relative(fontsDirectory, filename).split(path.sep).join('/')
        return [`assets/excalidraw/fonts/${relative}`, readFileSync(filename)] as const
      })
  )

  return {
    name: 'wework-excalidraw-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
        const prefix = server.config.base
        const asset = assets.get(pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '')
        if (!asset) return next()
        response.setHeader(
          'Content-Type',
          pathname.endsWith('.woff2') ? 'font/woff2' : 'text/plain'
        )
        response.end(asset)
      })
    },
    generateBundle() {
      for (const [fileName, source] of assets) {
        this.emitFile({ type: 'asset', fileName, source })
      }
    },
  }
}
