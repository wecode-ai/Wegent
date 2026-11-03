import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { authenticatedBrowserRequest, terminate } from './runtime-smoke-process.mjs'
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
let stderr = ''
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
  runtime = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: { ...launch.environment, WEWORK_DSH_BROWSER_AUTH_FD: '5' },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'pipe', 'ignore', 'ignore', 'pipe'],
  })
  runtime.stderr.setEncoding('utf8')
  runtime.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  const browserRequest = await authenticatedBrowserRequest(runtime, new URL(launch.url).origin)
  const html = await waitForApplication(runtime, launch.url, browserRequest)
  const unauthenticated = await fetch(new URL('/api/settings.describe', launch.url))
  if (unauthenticated.status !== 401)
    throw new Error('Workbench DSH accepted an unauthenticated API request')
  console.log(
    JSON.stringify(
      {
        app: manifest.name,
        profile: launch.profile,
        runtimeVersion: launch.version,
        sourceFingerprint: launch.sourceFingerprint,
        url: launch.url,
        pid: runtime.pid,
        htmlBytes: Buffer.byteLength(html),
        unauthenticatedApiStatus: unauthenticated.status,
      },
      null,
      2
    )
  )
} catch (error) {
  if (stderr.trim()) console.error(stderr.trim())
  throw error
} finally {
  if (runtime) await terminate(runtime)
  await rm(root, { recursive: true, force: true })
}

async function waitForApplication(child, url, request) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Workbench DSH exited before becoming ready')
    }
    const response = await request(url, { signal: AbortSignal.timeout(5_000) })
    const html = await response.text()
    if (response.ok && /<html[\s>]/i.test(html)) return html
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  throw new Error('Workbench DSH did not serve an authenticated application')
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
