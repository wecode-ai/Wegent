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

function preserveDshUiEntryExports() {
  return {
    name: 'wework-preserve-dsh-ui-entry-exports',
    options(options: {
      preserveEntrySignatures?: false | 'strict' | 'allow-extension' | 'exports-only'
    }) {
      return {
        ...options,
        preserveEntrySignatures: 'strict' as const,
      }
    },
    generateBundle(
      _options: unknown,
      bundle: Record<
        string,
        {
          exports?: string[]
          isEntry?: boolean
          name?: string
          type: 'asset' | 'chunk'
        }
      >
    ) {
      for (const output of Object.values(bundle)) {
        if (
          output.type === 'chunk' &&
          output.isEntry &&
          output.name?.startsWith('wework-ui-') &&
          !output.exports?.includes('default')
        ) {
          throw new Error(`DSH UI entry "${output.name}" must preserve its default export`)
        }
      }
    },
  }
}

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
    preserveDshUiEntryExports(),
    fileViewerRenderers({
      preset: 'auto',
      autoPresets: ['office', 'lite', 'engineering'],
      copyAssets: process.env.VITEST !== 'true',
      chunkStrategy: 'renderer',
    }),
  ],
  define: {
    __WEWORK_APP_VERSION__: JSON.stringify(packageJson.version ?? '0.0.0'),
  },
  optimizeDeps: {
    // Test artifacts may contain standalone plugin apps with dependencies that
    // are intentionally absent from Wework. Only crawl the desktop app entry.
    entries: ['index.html'],
    // The drawing renderer loads Mermaid dynamically. Pre-bundle the concrete
    // package so WebKit does not confuse it with syntax-language chunks.
    include: ['mermaid', 'plantuml-encoder'],
  },
  build: {
    // File-viewer renderers are split into dedicated chunks; the desktop shell
    // intentionally remains a single entry bundle.
    chunkSizeWarningLimit: 5_000,
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        'wework-ui-applications': path.resolve(__dirname, 'dsh/ui-applications/src/route.tsx'),
        'wework-ui-automations': path.resolve(__dirname, 'dsh/ui-automations/src/route.tsx'),
        'wework-ui-cloud-work': path.resolve(__dirname, 'dsh/ui-cloud-work/src/route.tsx'),
        'wework-ui-cloud-work-sidebar': path.resolve(
          __dirname,
          'dsh/ui-cloud-work/src/sidebar-navigation.tsx'
        ),
        'wework-ui-core-settings': path.resolve(
          __dirname,
          'dsh/ui-core-settings/src/settings-page.tsx'
        ),
        'wework-ui-core-apps': path.resolve(__dirname, 'dsh/ui-core-apps/src/app-surface.tsx'),
        'wework-ui-git-board-card-status': path.resolve(
          __dirname,
          'dsh/ui-git/src/board-card-status.tsx'
        ),
        'wework-ui-git-environment-section': path.resolve(
          __dirname,
          'dsh/ui-git/src/environment-section.tsx'
        ),
        'wework-ui-git-project-create-section': path.resolve(
          __dirname,
          'dsh/ui-git/src/project-create-section.tsx'
        ),
        'wework-ui-git-project-work-section': path.resolve(
          __dirname,
          'dsh/ui-git/src/project-work-section.tsx'
        ),
        'wework-ui-git-settings': path.resolve(__dirname, 'dsh/ui-git/src/settings-page.tsx'),
        'wework-ui-git-task-status': path.resolve(__dirname, 'dsh/ui-git/src/task-status.tsx'),
        'wework-ui-git-workspace-menu-section': path.resolve(
          __dirname,
          'dsh/ui-git/src/workspace-menu-section.tsx'
        ),
        'wework-ui-plugin-center-catalog': path.resolve(
          __dirname,
          'dsh/ui-plugin-center/src/catalog-route.tsx'
        ),
        'wework-ui-plugin-center-create': path.resolve(
          __dirname,
          'dsh/ui-plugin-center/src/create-route.tsx'
        ),
        'wework-ui-plugin-center-management': path.resolve(
          __dirname,
          'dsh/ui-plugin-center/src/management-route.tsx'
        ),
      },
      output: {
        entryFileNames: chunk =>
          chunk.name.startsWith('wework-ui-') ? 'plugins/[name].js' : 'assets/[name]-[hash].js',
      },
    },
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
    server: {
      deps: {
        inline: [/@file-viewer/, /@panzoom/],
      },
    },
    // Keep local and pre-push runs below the resource-contention point where
    // jsdom-heavy files begin timing out nondeterministically.
    maxWorkers: 2,
    exclude: [
      ...configDefaults.exclude,
      'dsh/**/*.test.mjs',
      'e2e/**',
      'scripts/electron-e2e-launch-arguments.test.mjs',
      'scripts/harness-runtime-metadata.test.mjs',
      'test-results/**',
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
})
