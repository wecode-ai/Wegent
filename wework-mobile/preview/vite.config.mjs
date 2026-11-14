import path from 'node:path'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import desktopTailwind from '../../wework/tailwind.config.js'

const root = fileURLToPath(new URL('.', import.meta.url))
const desktop = path.resolve(root, '../../wework')
const requireDesktop = createRequire(path.join(desktop, 'package.json'))
const { default: react } = await import(
  pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react'))
)
const { fileViewerRenderers } = await import(
  pathToFileURL(requireDesktop.resolve('@file-viewer/vite-plugin'))
)
const tailwindcss = requireDesktop('tailwindcss')
const autoprefixer = requireDesktop('autoprefixer')
const shared = path.resolve(root, '../../packages/collaboration')
const browserPackages = [
  'react',
  'react-dom',
  '@file-viewer/react',
  '@file-viewer/preset-office',
  '@file-viewer/preset-lite',
  '@file-viewer/preset-engineering',
  'jszip',
]
const pierreDirectory = path.join(desktop, 'node_modules/@pierre/diffs')
const pierreExports = JSON.parse(
  readFileSync(path.join(pierreDirectory, 'package.json'), 'utf8')
).exports
const pierreAliases = ['.', './react', './worker/worker.js'].map(entry => ({
  find:
    entry === '.'
      ? /^@pierre\/diffs$/
      : new RegExp(`^@pierre/diffs/${entry.slice(2).replaceAll('.', '\\.')}(?=\\?|$)`),
  replacement: path.resolve(pierreDirectory, pierreExports[entry].import),
}))

export default {
  logLevel: 'warn',
  root,
  base: './',
  publicDir: false,
  plugins: [
    react(),
    fileViewerRenderers({
      preset: 'auto',
      autoPresets: ['office', 'lite', 'engineering'],
      copyAssets: { mode: 'build' },
      chunkStrategy: 'renderer',
    }),
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      ...pierreAliases,
      ...browserPackages.map(name => ({
        find: name,
        replacement: path.join(desktop, 'node_modules', name),
      })),
    ],
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          ...desktopTailwind,
          content: [
            path.join(root, '**/*.{html,tsx}'),
            path.join(shared, 'src/**/*.{ts,tsx}'),
            path.join(shared, 'node_modules/streamdown/dist/*.js'),
          ],
        }),
        autoprefixer(),
      ],
    },
  },
  worker: { format: 'es' },
  build: {
    outDir: path.resolve(root, '../dist/wework-preview'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
    target: ['es2022', 'safari17'],
  },
}
