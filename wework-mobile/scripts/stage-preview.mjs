import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const destination = process.argv[2]
if (!destination || path.basename(destination) !== 'wework-preview') {
  throw new Error('Expected a native build destination named wework-preview')
}
const build = spawnSync(process.execPath, [path.join(mobile, 'scripts/build-preview.mjs')], {
  cwd: mobile,
  stdio: 'inherit',
})
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)
const source = path.join(mobile, 'dist/wework-preview')
if (!existsSync(path.join(source, 'preview-assets.json')))
  throw new Error('Preview assets were not built')
rmSync(destination, { recursive: true, force: true })
mkdirSync(path.dirname(destination), { recursive: true })
cpSync(source, destination, { recursive: true })
console.log(`Staged file preview assets in ${destination}`)
