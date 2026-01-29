import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig(({ mode }) => {
  const isChrome = mode === 'chrome' || mode === 'development'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
        '@chrome': resolve(__dirname, 'chrome'),
      },
    },
    build: {
      outDir: isChrome ? 'dist/chrome' : 'dist/safari',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          popup: resolve(__dirname, 'chrome/popup/index.html'),
          'service-worker': resolve(__dirname, 'chrome/service-worker.ts'),
          'content-script': resolve(__dirname, 'chrome/content-script.ts'),
        },
        output: {
          entryFileNames: (chunkInfo) => {
            if (chunkInfo.name === 'service-worker' || chunkInfo.name === 'content-script') {
              return '[name].js'
            }
            return 'assets/[name]-[hash].js'
          },
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
        },
      },
    },
    publicDir: 'chrome/assets',
  }
})
