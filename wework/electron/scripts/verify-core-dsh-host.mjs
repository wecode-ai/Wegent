import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { prepareCoreDshLaunch } from '../dist/runtime/core-dsh-runtime.js'

const requestedRoot = process.argv[2]
const requestedPluginsRoot = process.argv[3]
if (!requestedRoot || !requestedPluginsRoot) {
  throw new Error(
    'Usage: pnpm verify:core-dsh-host <materialized-core-runtime-root> <core-plugins-root>'
  )
}

const home = await mkdtemp(join(tmpdir(), 'wework-electron-dsh-'))
const token = randomBytes(32).toString('base64url')
let child = null
let stderr = ''
const executor = await startFakeExecutor(home)

try {
  const port = await freePort()
  const launch = await prepareCoreDshLaunch({
    runtimeRoot: resolve(requestedRoot),
    dataDirectory: home,
    environment: {
      ...process.env,
      WEWORK_CORE_PLUGIN_ROOT: resolve(requestedPluginsRoot),
      WEWORK_NODE_PATH: process.execPath,
    },
    port,
  })
  child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      DSH_HOME: launch.dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      PATH: `${join(launch.cwd, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
      WEWORK_ELECTRON_HOST_PROTOCOL: '1',
      WEWORK_ELECTRON_HOST_TOKEN: token,
      WEWORK_ELECTRON_HOST_REQUEST_FD: '3',
      WEWORK_ELECTRON_HOST_RESPONSE_FD: '4',
      WEWORK_EXECUTOR_ENDPOINT: executor.endpoint,
      WEWORK_EXECUTOR_TOKEN: executor.token,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  attachFakeElectronHost(child, token)

  const baseUrl = `http://127.0.0.1:${port}/wework/electron-host/v1`
  const description = await waitForJson(baseUrl, child)
  assertEqual(description.protocolVersion, 1, 'protocol version')
  assertDeepEqual(description.capabilities, ['app.getVersion'], 'capabilities')

  const response = await fetch(`${baseUrl}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: 'app.getVersion',
      params: {},
    }),
  })
  const invocation = await response.json()
  if (!response.ok) {
    throw new Error(`Host invocation failed: ${JSON.stringify(invocation)}`)
  }
  assertDeepEqual(
    invocation,
    { ok: true, result: { version: 'electron-smoke' } },
    'capability response'
  )
  const executorDescription = await waitForJson(
    `http://127.0.0.1:${port}/wework/executor/v1`,
    child
  )
  assertEqual(executorDescription.protocolVersion, 1, 'executor protocol version')
  const executorResponse = await fetch(`http://127.0.0.1:${port}/wework/executor/v1/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'executor.health', params: {} }),
  })
  const executorInvocation = await executorResponse.json()
  if (!executorResponse.ok) {
    throw new Error(`Executor invocation failed: ${JSON.stringify(executorInvocation)}`)
  }
  assertDeepEqual(executorInvocation, { ok: true, result: { healthy: true } }, 'executor response')
  const packagedAppHtml = await waitForText(`http://127.0.0.1:${port}/wework/app/`, child)
  if (
    !packagedAppHtml.includes('window.__WEWORK_RUNTIME_CONFIG__') ||
    !packagedAppHtml.includes('/wework/app/assets/')
  ) {
    throw new Error('Packaged Wework application is missing from the Core DSH host')
  }
  const html = await waitForText(`http://127.0.0.1:${port}/`, child)
  const entries = bootEntries(html)
  const desktopEntry = entries.find(entry => entry.id === '@wegent/dsh-electron-host')
  if (!desktopEntry || typeof desktopEntry.url !== 'string') {
    throw new Error(
      `Wework desktop client is missing from the DSH browser boot graph: ${JSON.stringify(
        entries.map(entry => entry.id)
      )}`
    )
  }
  const desktopBundle = await waitForText(
    new URL(desktopEntry.url, `http://127.0.0.1:${port}`).toString(),
    child
  )
  if (!desktopBundle.includes("ctx.reflect.provide('weworkDesktop'")) {
    throw new Error('Wework desktop client bundle did not provide the expected service')
  }
  const appEntry = entries.find(entry => entry.id === '@wegent/dsh-app-wework')
  if (!appEntry || typeof appEntry.url !== 'string') {
    throw new Error(
      `Wework app is missing from the DSH browser boot graph: ${JSON.stringify(
        entries.map(entry => entry.id)
      )}`
    )
  }
  const appBundle = await waitForText(
    new URL(appEntry.url, `http://127.0.0.1:${port}`).toString(),
    child
  )
  if (!appBundle.includes("id: '@wegent/dsh-app-wework'")) {
    throw new Error('Wework app client bundle did not serve the expected module registration')
  }
  console.log(
    JSON.stringify(
      {
        runtimeRoot: launch.cwd,
        version: launch.version,
        sourceFingerprint: launch.sourceFingerprint,
        profileName: launch.profile,
        protocolVersion: description.protocolVersion,
        capabilities: description.capabilities,
        invocation,
        executorInvocation,
        packagedAppBytes: Buffer.byteLength(packagedAppHtml),
        desktopClientPlugin: {
          id: desktopEntry.id,
          url: desktopEntry.url,
          bytes: Buffer.byteLength(desktopBundle),
        },
        browserPlugin: {
          id: appEntry.id,
          url: appEntry.url,
          bytes: Buffer.byteLength(appBundle),
        },
      },
      null,
      2
    )
  )
} catch (error) {
  if (stderr.trim()) console.error(stderr.trim())
  throw error
} finally {
  if (child) await terminate(child)
  await executor.stop()
  await rm(home, { recursive: true, force: true })
}

async function startFakeExecutor(directory) {
  const token = randomBytes(32).toString('base64url')
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\wework-dsh-smoke-${process.pid}-${Date.now()}`
      : join(directory, 'executor.sock')
  const clients = new Set()
  const server = createServer(socket => {
    clients.add(socket)
    socket.setEncoding('utf8')
    let authenticated = false
    let buffered = ''
    socket.on('data', chunk => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (!authenticated) {
          authenticated =
            message.type === 'authenticate' &&
            message.protocol_version === 1 &&
            message.token === token
          socket.write(
            `${JSON.stringify({
              type: 'authenticated',
              ok: authenticated,
              protocol_version: 1,
              ...(!authenticated
                ? { error: { message: 'Local executor authentication failed' } }
                : {}),
            })}\n`
          )
          if (!authenticated) socket.end()
          continue
        }
        const result =
          message.method === 'executor.protocol.describe'
            ? {
                protocol_version: 1,
                device_id: 'electron-smoke',
                capabilities: ['executor.health'],
                transports: ['local-endpoint-ndjson'],
                features: {
                  request_response: true,
                  events: true,
                  structured_errors: true,
                  compressed_responses: true,
                  event_resume: false,
                },
              }
            : { healthy: true }
        socket.write(
          `${JSON.stringify({
            type: 'response',
            id: message.id,
            ok: true,
            result,
          })}\n`
        )
      }
    })
    socket.on('close', () => clients.delete(socket))
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolvePromise)
  })
  return {
    endpoint,
    token,
    stop: async () => {
      for (const client of clients) client.destroy()
      await new Promise((resolvePromise, reject) =>
        server.close(error => (error ? reject(error) : resolvePromise()))
      )
    },
  }
}

function attachFakeElectronHost(processHandle, expectedToken) {
  const requests = processHandle.stdio[4]
  const responses = processHandle.stdio[3]
  if (!requests || !responses) throw new Error('Inherited host pipes are missing')
  const lines = createInterface({ input: requests })
  lines.on('line', line => {
    const message = JSON.parse(line)
    if (message.type === 'hello') {
      assertEqual(message.protocolVersion, 1, 'handshake protocol')
      assertEqual(message.token, expectedToken, 'handshake token')
      assertEqual(message.principal, '@wegent/dsh-app-wework', 'handshake principal')
      responses.write(
        `${JSON.stringify({
          type: 'hello',
          ok: true,
          protocolVersion: 1,
          capabilities: ['app.getVersion'],
        })}\n`
      )
      return
    }
    if (message.type !== 'request' || message.capability !== 'app.getVersion') {
      throw new Error(`Unexpected host request: ${line}`)
    }
    responses.write(
      `${JSON.stringify({
        type: 'response',
        id: message.id,
        ok: true,
        result: { version: 'electron-smoke' },
      })}\n`
    )
  })
}

async function waitForJson(url, processHandle) {
  let lastError
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (processHandle.exitCode !== null) {
      throw new Error(`DSH exited before becoming ready: ${processHandle.exitCode}`)
    }
    try {
      const response = await fetch(url)
      const contentType = response.headers.get('content-type') ?? ''
      if (response.ok && contentType.startsWith('application/json')) {
        return response.json()
      }
      lastError = new Error(
        `DSH route is not ready: HTTP ${response.status} ${contentType || 'unknown'}`
      )
    } catch (error) {
      lastError = error
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  throw new Error(`DSH did not become ready at ${url}`, { cause: lastError })
}

async function waitForText(url, processHandle) {
  let lastError
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (processHandle.exitCode !== null) {
      throw new Error(`DSH exited before becoming ready: ${processHandle.exitCode}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return response.text()
      lastError = new Error(`DSH route is not ready: HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  throw new Error(`DSH did not become ready at ${url}`, { cause: lastError })
}

function bootEntries(html) {
  const prefixes = ['globalThis["__DSH_BOOT__"] = ', 'window.__DSH_BOOT__ = ']
  const prefix = prefixes.find(candidate => html.includes(candidate))
  const start = prefix ? html.indexOf(prefix) : -1
  if (start < 0) throw new Error('DSH page did not inject a browser boot graph')
  const tail = html.slice(start + prefix.length)
  const end = tail.indexOf('</script>')
  if (end < 0) throw new Error('DSH browser boot graph script is unterminated')
  const graph = JSON.parse(tail.slice(0, end).trim().replace(/;$/, ''))
  if (!graph || !Array.isArray(graph.entries)) {
    throw new Error('DSH browser boot graph is malformed')
  }
  return graph.entries
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate a loopback port'))
        return
      }
      server.close(error => {
        if (error) reject(error)
        else resolvePromise(address.port)
      })
    })
  })
}

async function terminate(processHandle) {
  if (processHandle.exitCode !== null) return
  const exited = new Promise(resolvePromise => processHandle.once('exit', resolvePromise))
  try {
    if (process.platform === 'win32') processHandle.kill()
    else if (processHandle.pid) process.kill(-processHandle.pid, 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  const timeout = new Promise(resolvePromise => setTimeout(resolvePromise, 2_000, 'timeout'))
  if ((await Promise.race([exited, timeout])) !== 'timeout') return
  try {
    if (process.platform === 'win32') processHandle.kill('SIGKILL')
    else if (processHandle.pid) process.kill(-processHandle.pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  await exited
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}
