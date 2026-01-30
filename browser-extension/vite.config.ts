import { defineConfig, build } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'fs'

// Safari Web Extensions require conversion via xcrun safari-web-extension-converter
// Use `npm run build:safari` to build Chrome extension and convert to Safari Xcode project
export default defineConfig(() => {
  return {
    plugins: [
      react(),
      {
        name: 'build-content-script-iife',
        async closeBundle() {
          // Build content-script separately as IIFE format
          // Content scripts cannot use ES modules in Chrome extensions
          await build({
            configFile: false,
            build: {
              outDir: 'dist/chrome',
              emptyOutDir: false,
              lib: {
                entry: resolve(__dirname, 'chrome/content-script.ts'),
                name: 'WegentContentScript',
                formats: ['iife'],
                fileName: () => 'content-script.js',
              },
              rollupOptions: {
                output: {
                  // Inline all dependencies into the IIFE bundle
                  inlineDynamicImports: true,
                },
              },
            },
            resolve: {
              alias: {
                '@shared': resolve(__dirname, 'shared'),
                '@chrome': resolve(__dirname, 'chrome'),
              },
            },
          })
        },
      },
      {
        name: 'copy-extension-files',
        writeBundle() {
          const outDir = resolve(__dirname, 'dist/chrome')
          if (!existsSync(outDir)) {
            mkdirSync(outDir, { recursive: true })
          }
          // Copy manifest.json
          copyFileSync(
            resolve(__dirname, 'chrome/manifest.json'),
            resolve(outDir, 'manifest.json')
          )
          // Copy icon PNG files
          const iconSizes = ['16', '32', '48', '128']
          for (const size of iconSizes) {
            const iconFile = `icon-${size}.png`
            const srcPath = resolve(__dirname, 'chrome', iconFile)
            if (existsSync(srcPath)) {
              copyFileSync(srcPath, resolve(outDir, iconFile))
            }
          }
          // Fix popup directory structure: move chrome/popup to popup
          const wrongPopupDir = resolve(outDir, 'chrome/popup')
          const correctPopupDir = resolve(outDir, 'popup')
          if (existsSync(wrongPopupDir)) {
            if (existsSync(correctPopupDir)) {
              rmSync(correctPopupDir, { recursive: true })
            }
            mkdirSync(correctPopupDir, { recursive: true })
            renameSync(
              resolve(wrongPopupDir, 'index.html'),
              resolve(correctPopupDir, 'index.html')
            )
            // Clean up wrong directory
            rmSync(resolve(outDir, 'chrome'), { recursive: true })
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
        '@chrome': resolve(__dirname, 'chrome'),
      },
    },
    base: './',
    build: {
      outDir: 'dist/chrome',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          popup: resolve(__dirname, 'chrome/popup/index.html'),
          'service-worker': resolve(__dirname, 'chrome/service-worker.ts'),
        },
        output: {
          entryFileNames: (chunkInfo) => {
            if (chunkInfo.name === 'service-worker') {
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
