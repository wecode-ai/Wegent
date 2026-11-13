import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

export function packagedResourcesRoot(appBinary) {
  return process.platform === 'darwin'
    ? resolve(appBinary, '..', '..', 'Resources')
    : resolve(appBinary, '..', 'resources')
}

export async function readPackagedNamespace(appBinary, environment) {
  const resourcesRoot = packagedResourcesRoot(appBinary)
  // Electron's filesystem reads the package metadata inside the actual app.asar.
  const script =
    "const fs = require('node:fs'); " +
    "const metadata = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); " +
    "process.stdout.write(JSON.stringify(metadata.weworkExecutorNamespace?.trim() || ''))"
  const { stdout } = await promisify(execFile)(
    appBinary,
    ['-e', script, join(resourcesRoot, 'app.asar', 'package.json')],
    { env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000 }
  )
  const namespace = JSON.parse(stdout)
  assert.equal(typeof namespace, 'string')
  if (namespace) assert.match(namespace, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  return namespace
}
