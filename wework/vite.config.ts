/// <reference types="vitest/config" />

import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000'
const socketProxyTarget = process.env.VITE_SOCKET_PROXY_TARGET || apiProxyTarget
const configuredAppBasePath = process.env.VITE_APP_BASE_PATH || '/'
const appBasePath = configuredAppBasePath.endsWith('/')
  ? configuredAppBasePath
  : `${configuredAppBasePath}/`

export default defineConfig({
  base: appBasePath,
  plugins: [react()],
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
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
  },
})
