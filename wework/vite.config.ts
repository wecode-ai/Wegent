/// <reference types="vitest/config" />

import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000'
const socketProxyTarget = process.env.VITE_SOCKET_PROXY_TARGET || apiProxyTarget

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
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
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
  },
})
