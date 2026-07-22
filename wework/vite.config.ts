import path from 'path'
import fs from 'fs'
import { createLogger, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileViewerRenderers } from '@file-viewer/vite-plugin'
import { configDefaults } from 'vitest/config'

function normalizeBackendUrl(value: string): string {
  const url = new URL(value)
  const segments = url.pathname.split('/').filter(Boolean)
  const apiIndex = segments.indexOf('api')
  const backendSegments = apiIndex >= 0 ? segments.slice(0, apiIndex) : segments
  url.pathname = backendSegments.length > 0 ? `/${backendSegments.join('/')}` : '/'
  return url.toString().replace(/\/$/, '')
}

const backendProxyTarget = normalizeBackendUrl(
  process.env.VITE_WEGENT_BACKEND_URL || 'http://localhost:8000'
)
const socketProxyTarget = process.env.VITE_WEGENT_SOCKET_URL || backendProxyTarget
const configuredAppBasePath = process.env.VITE_APP_BASE_PATH || '/'
const appBasePath = configuredAppBasePath.endsWith('/')
  ? configuredAppBasePath
  : `${configuredAppBasePath}/`
const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')
) as {
  version?: string
}
const internalExtensionsDir = path.resolve(__dirname, './wecode/extensions')
const extensionsDir = fs.existsSync(path.join(internalExtensionsDir, 'apps.tsx'))
  ? internalExtensionsDir
  : path.resolve(__dirname, './src/extensions')
const logger = createLogger()
const defaultWarn = logger.warn.bind(logger)
const browserExternalPackages = ['/avsc/', '/ag-psd/', '/jszip/', '/@ljheee/xmind-parser/']

logger.warn = (message, options) => {
  const isKnownBrowserExternal =
    message.includes('has been externalized for browser compatibility') &&
    browserExternalPackages.some(packagePath => message.includes(packagePath))
  if (!isKnownBrowserExternal) defaultWarn(message, options)
}

export default defineConfig({
  base: appBasePath,
  customLogger: logger,
  plugins: [
    react(),
    fileViewerRenderers({
      preset: 'auto',
      autoPresets: ['office', 'lite', 'engineering'],
      copyAssets: true,
      chunkStrategy: 'renderer',
    }),
  ],
  define: {
    __WEWORK_APP_VERSION__: JSON.stringify(packageJson.version ?? '0.0.0'),
  },
  build: {
    // File-viewer renderers are split into dedicated chunks; the desktop shell
    // intentionally remains a single entry bundle.
    chunkSizeWarningLimit: 5_000,
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/wework/api': {
        target: backendProxyTarget,
        changeOrigin: true,
        rewrite: path => path.replace(/^\/wework\/api/, '/api'),
      },
      '/wework/socket.io': {
        target: socketProxyTarget,
        changeOrigin: true,
        ws: true,
        rewrite: path => path.replace(/^\/wework\/socket\.io/, '/socket.io'),
      },
      '/api': {
        target: backendProxyTarget,
        changeOrigin: true,
        ws: true,
      },
      '/socket.io': {
        target: socketProxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@xmldom/xmldom': path.resolve(__dirname, './src/lib/browser-dom-parser.ts'),
      '@': path.resolve(__dirname, './src'),
      '@wecode': path.resolve(__dirname, './wecode'),
      '@extensions': extensionsDir,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
    exclude: [...configDefaults.exclude, 'e2e/**', 'test-results/**'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
})
