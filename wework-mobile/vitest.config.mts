import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    dedupe: ['socket.io-client'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@pierre/diffs': fileURLToPath(
        new URL('../wework/node_modules/@pierre/diffs/dist/index.js', import.meta.url)
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'preview/**/*.test.ts'],
  },
})
