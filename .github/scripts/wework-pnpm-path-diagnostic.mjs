import { mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join, toNamespacedPath } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = join(process.cwd(), '.ci-artifacts', 'pnpm-path-experiment')
mkdirSync(root, { recursive: true })
const plugin = join(root, 'local-plugin')
mkdirSync(plugin)
writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'diagnostic-local-plugin', version: '1.0.0' }))
const results = []
for (const deep of [false, true]) for (const explicitDir of [false, true]) {
  let profile = join(root, `${deep}-${explicitDir}`)
  while (deep && profile.length < 320) profile = join(profile, 'deep-profile-directory')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'diagnostic-profile', private: true, version: '1.0.0' }))
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  const args = [process.argv[2], '--offline', '--reporter', 'ndjson', '--store-dir', join(root, 'store'), ...(explicitDir ? ['--dir', profile] : []), 'add', plugin]
  const result = spawnSync(process.execPath, args, { cwd: toNamespacedPath(profile), encoding: 'utf8', timeout: 30000 })
  results.push({ deep, explicitDir, profile, physicalPath: realpathSync.native(toNamespacedPath(profile)), status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr })
}
writeFileSync(join(root, '..', 'pnpm-native-paths.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results.map(({ stdout, stderr, ...result }) => ({ ...result, errors: (stdout + stderr).split('\n').filter(line => /error|ERROR|EISDIR/i.test(line)) })), null, 2))
