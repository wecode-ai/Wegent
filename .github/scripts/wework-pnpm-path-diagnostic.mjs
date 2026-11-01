import { mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join, toNamespacedPath } from 'node:path'
import { execFile } from 'node:child_process'
const root = join(process.cwd(), '.ci-artifacts', 'pnpm-path-experiment')
mkdirSync(root, { recursive: true })
const plugin = join(root, 'local-plugin')
mkdirSync(plugin)
writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'diagnostic-local-plugin', version: '1.0.0' }))
const existing = join(root, 'existing-plugin')
mkdirSync(existing)
writeFileSync(join(existing, 'package.json'), JSON.stringify({ name: 'diagnostic-existing-plugin', version: '1.0.0' }))
const results = []
for (const runtime of ['node', 'electron']) for (const deep of [false, true]) for (const explicitDir of [false, true]) {
  let profile = join(root, `${runtime}-${deep}-${explicitDir}`)
  while (deep && profile.length < 320) profile = join(profile, 'deep-profile-directory')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'diagnostic-profile', private: true, version: '1.0.0', dependencies: { 'diagnostic-existing-plugin': `file:${existing}` } }))
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  const args = [...(runtime === 'electron' ? ['--expose-internals'] : []), process.argv[2], '--offline', '--reporter', 'ndjson', '--store-dir', join(root, 'store'), ...(explicitDir ? ['--dir', profile] : []), 'add', plugin]
  const result = await new Promise(resolve => execFile(runtime === 'electron' ? process.argv[3] : process.execPath, args, { cwd: toNamespacedPath(profile), env: {...process.env, ...(runtime === 'electron' ? {ELECTRON_RUN_AS_NODE: '1'} : {})}, encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => resolve({status: error?.code ?? 0, error: error?.message, stdout, stderr})))
  results.push({ runtime, deep, explicitDir, profile, physicalPath: realpathSync.native(toNamespacedPath(profile)), ...result })
}
writeFileSync(join(root, '..', 'pnpm-native-paths.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results.map(({ stdout, stderr, ...result }) => ({ ...result, errors: `${stdout ?? ''}${stderr ?? ''}`.split('\n').filter(line => /error|ERROR|EISDIR/i.test(line)) })), null, 2))
