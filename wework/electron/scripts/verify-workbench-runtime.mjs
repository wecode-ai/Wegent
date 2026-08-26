import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { DshRuntime } from '../dist/runtime/dsh-runtime.js'
import { prepareWorkbenchDshLaunch } from '../dist/runtime/workbench-dsh-runtime.js'

const runtimeRoot = process.argv[2]
const packagePath = process.argv[3]
if (!runtimeRoot || !packagePath) {
  throw new Error(
    'Usage: pnpm verify:workbench-runtime <materialized-runtime-root> <installed-app-package>'
  )
}

const root = await mkdtemp(join(tmpdir(), 'wework-workbench-runtime-'))
let runtime = null
try {
  const manifest = JSON.parse(
    await readFile(join(resolve(packagePath), 'plugin-manifest.json'), 'utf8')
  )
  const port = await freePort()
  const launch = await prepareWorkbenchDshLaunch({
    runtimeRoot: resolve(runtimeRoot),
    dataDirectory: root,
    installationId: manifest.name,
    packagePath: resolve(packagePath),
    manifest,
    environment: {
      ...process.env,
      DSH_TELEMETRY_DISABLED: '1',
      WEWORK_NODE_PATH: process.execPath,
    },
    port,
  })
  runtime = new DshRuntime({
    name: 'workbench-smoke',
    url: launch.url,
    probeUrl: launch.url,
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.environment,
    logDirectory: join(root, 'logs'),
    logFileName: 'workbench-smoke.log',
  })
  await runtime.start()
  const response = await fetch(launch.url)
  const html = await response.text()
  if (!response.ok || !/<html[\s>]/i.test(html)) {
    throw new Error(`Workbench DSH did not serve an application: HTTP ${response.status}`)
  }
  console.log(
    JSON.stringify(
      {
        app: manifest.name,
        profile: launch.profile,
        runtimeVersion: launch.version,
        sourceFingerprint: launch.sourceFingerprint,
        url: launch.url,
        pid: runtime.pid(),
        htmlBytes: Buffer.byteLength(html),
      },
      null,
      2
    )
  )
} catch (error) {
  try {
    console.error(await readFile(join(root, 'logs', 'workbench-smoke.log'), 'utf8'))
  } catch {
    // The failed runtime may not have produced a log yet.
  }
  throw error
} finally {
  await runtime?.stop()
  await rm(root, { recursive: true, force: true })
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate a Workbench DSH port'))
        return
      }
      server.close(error => {
        if (error) reject(error)
        else resolvePromise(address.port)
      })
    })
  })
}
