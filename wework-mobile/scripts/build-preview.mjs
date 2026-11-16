import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const mobile = fileURLToPath(new URL('..', import.meta.url))
const repository = path.dirname(mobile)
const output = path.join(mobile, 'dist/wework-preview')
const manifestPath = path.join(output, 'preview-assets.json')
const filesIn = directory =>
  existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory()
          ? filesIn(path.join(directory, entry.name))
          : [path.join(directory, entry.name)]
      )
    : []
const sources = [
  ...filesIn(path.join(mobile, 'preview')),
  ...filesIn(path.join(repository, 'packages/collaboration/src')),
  ...filesIn(path.join(repository, 'packages/chat-core/src')),
  path.join(repository, 'packages/collaboration/package.json'),
  path.join(repository, 'packages/collaboration/tailwind-preset.js'),
  path.join(repository, 'wework/tailwind.config.js'),
  path.join(repository, 'wework/package.json'),
  path.join(repository, 'pnpm-lock.yaml'),
  fileURLToPath(import.meta.url),
].sort()
const hash = createHash('sha256')
for (const file of sources) hash.update(path.relative(repository, file)).update(readFileSync(file))
const version = hash.digest('hex')
let previous
if (existsSync(manifestPath)) {
  try {
    previous = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    /* Rebuild an invalid generated manifest. */
  }
}
if (
  !process.argv.includes('--force') &&
  previous?.version === version &&
  previous.files?.length &&
  previous.files.every(
    file =>
      existsSync(path.join(output, file.path)) &&
      statSync(path.join(output, file.path)).size === file.size
  )
) {
  console.log('[FilePreview] Bundle is current')
  process.exit(0)
}
const result = spawnSync(
  'pnpm',
  [
    '--dir',
    path.join(repository, 'wework'),
    'exec',
    'vite',
    'build',
    '--config',
    path.join(mobile, 'preview/vite.config.mjs'),
  ],
  { stdio: 'inherit', cwd: repository }
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
// The upstream diagnostic manifest contains host paths and timestamps; ship our reproducible manifest.
rmSync(path.join(output, 'flyfish-viewer-assets.json'), { force: true })
const files = filesIn(output)
  .filter(file => file !== manifestPath)
  .map(file => ({ path: path.relative(output, file), size: statSync(file).size }))
  .sort((a, b) => a.path.localeCompare(b.path))
for (const required of [
  'index.html',
  'vendor/pdf/pdf.worker.mjs',
  'vendor/docx/docx.worker.js',
  'vendor/pptx/pptx.worker.js',
  'vendor/libarchive/libarchive.wasm',
]) {
  if (!files.some(file => file.path === required))
    throw new Error(`Missing preview resource: ${required}`)
}
writeFileSync(manifestPath, `${JSON.stringify({ version, files }, null, 2)}\n`)
console.log(
  `[FilePreview] Built ${files.length} resources, ${(files.reduce((sum, file) => sum + file.size, 0) / 1048576).toFixed(1)} MiB`
)
