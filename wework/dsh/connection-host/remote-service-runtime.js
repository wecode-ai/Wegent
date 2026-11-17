import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { prepareRemoteConnectionProfile } from './remote-profile.js'
import { acquireRemoteConnectionLock } from './remote-lifecycle.js'
import { readConnectionRuntimeDelivery } from './remote-delivery.js'

export async function runRemoteConnectionService(args, acquireLock = acquireRemoteConnectionLock) {
  const [manifestPath, dataRoot, rawOwner, ...extra] = args
  if (!manifestPath || !dataRoot || !rawOwner || extra.length)
    throw new Error('Connection service requires a delivered manifest, data root and owner')
  const manifest = await readConnectionRuntimeDelivery(manifestPath)
  if (!process.env.WEWORK_EXECUTOR_ENDPOINT || !process.env.WEWORK_EXECUTOR_TOKEN)
    throw new Error('Connection service requires its dedicated native read endpoint')
  const ownerId = Number(rawOwner)
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0)
    throw new Error('Connection service owner is invalid')
  const lockExecutable = process.env.WEWORK_CONNECTION_LOCK_EXECUTABLE

  // Plugins receive transport and network settings, never Backend or model credentials.
  const allowed = new Set([
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'ELECTRON_RUN_AS_NODE',
    'WEWORK_EXECUTOR_ENDPOINT',
    'WEWORK_EXECUTOR_TOKEN',
  ])
  for (const key of Object.keys(process.env)) if (!allowed.has(key)) delete process.env[key]
  await acquireLock(
    lockExecutable,
    join(dataRoot, 'accounts', String(ownerId), '.connection-service.lock')
  )
  const prepared = await prepareRemoteConnectionProfile({
    dataRoot,
    ownerId,
    runtimeRoot: manifest.runtimeRoot,
    packageRoots: manifest.packageRoots,
  })
  Object.assign(process.env, prepared.environment)
  process.chdir(prepared.environment.HOME)
  process.argv = [process.execPath, ...prepared.args]
  const { runCli } = await import(pathToFileURL(prepared.entry))
  await runCli()
}
