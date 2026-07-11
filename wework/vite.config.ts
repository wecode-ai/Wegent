import path from 'path'
import fs from 'fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { configDefaults } from 'vitest/config'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000'
const socketProxyTarget = process.env.VITE_SOCKET_PROXY_TARGET || apiProxyTarget
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

export default defineConfig({
  base: appBasePath,
  plugins: [react()],
  define: {
    __WEWORK_APP_VERSION__: JSON.stringify(packageJson.version ?? '0.0.0'),
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/wework/api': {
        target: apiProxyTarget,
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
        target: apiProxyTarget,
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
