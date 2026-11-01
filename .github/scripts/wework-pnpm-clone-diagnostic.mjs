import { execFile } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, toNamespacedPath } from 'node:path'
import { createRequire } from 'node:module'

const root = join(process.cwd(), '..', '.ci-artifacts', 'pnpm-clone')
await mkdir(root, { recursive: true })
const require = createRequire(new URL('../../wework/electron/package.json', import.meta.url))
const electron = require('electron')
const parent = join(root, 'parent.cjs')
await writeFile(parent, `
const { execFile } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, toNamespacedPath } = require('node:path')
const root = ${JSON.stringify(root)}
const results = []
;(async () => {
for (const deep of [false, true]) for (const method of ['auto', 'hardlink', 'copy']) {
  const profile = join(root, 'profile-' + deep + '-' + method)
  let store = join(root, 'store-' + deep + '-' + method)
  while (deep && store.length < 175) store = join(store, 'nested-store-directory')
  mkdirSync(toNamespacedPath(profile), { recursive: true })
  mkdirSync(toNamespacedPath(store), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'pnpm-clone-probe', private: true, dependencies: { 'is-number': '7.0.0' } }))
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\\n  - .\\n')
  const args = [${JSON.stringify(process.env.npm_execpath)}, '--dir', profile, '--store-dir', store, '--package-import-method=' + method, 'install']
  const result = await new Promise(resolve => execFile(process.execPath, args, { cwd: toNamespacedPath(profile), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr })))
  results.push({ deep, method, profile, store, storeLength: store.length, ...result })
  console.log(JSON.stringify(results.at(-1)))
}
writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })
`)
await new Promise((resolve, reject) => execFile(electron, [parent], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 210000, encoding: 'utf8',
}, (error, stdout, stderr) => {
  console.log(stdout)
  console.error(stderr)
  error ? reject(error) : resolve()
}))
console.log(await readFile(join(root, 'results.json'), 'utf8'))
