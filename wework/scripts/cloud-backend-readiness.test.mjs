import { once } from 'node:events'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import {
  waitForUvicornReady,
  withBackendGatewayPortLease,
} from '../e2e/desktop/modules/cloud-environment.mjs'

const cleanups = []
const running = () => ({ exitCode: null, signalCode: null })
const startupLine = port =>
  `INFO: Uvicorn running on http://127.0.0.1:${port} (Press CTRL+C to quit)\n`

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function logFile(content = '') {
  const directory = await mkdtemp(join(tmpdir(), 'wework-uvicorn-startup-'))
  cleanups.push(() => rm(directory, { force: true, recursive: true }))
  const path = join(directory, 'backend.log')
  await writeFile(path, content)
  return path
}

async function serveDocs() {
  const paths = []
  const server = createServer((request, response) => {
    paths.push(request.url)
    response.end('ready')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => new Promise(resolve => server.close(resolve)))
  return { paths, port: server.address().port }
}

test('uses the kernel-bound port and verifies the actual Python readiness URL', async () => {
  const { paths, port } = await serveDocs()
  const path = await logFile(startupLine(port))

  await expect(waitForUvicornReady(running(), path, { timeoutMs: 1000 })).resolves.toBe(port)
  expect(paths).toEqual(['/api/docs'])
})

test('a restart ignores the previous process startup line', async () => {
  const oldServer = await serveDocs()
  const newServer = await serveDocs()
  const oldLog = startupLine(oldServer.port)
  const path = await logFile(oldLog)
  const ready = waitForUvicornReady(running(), path, {
    fromOffset: oldLog.length,
    timeoutMs: 1000,
  })
  await appendFile(path, startupLine(newServer.port))

  await expect(ready).resolves.toBe(newServer.port)
  expect(oldServer.paths).toEqual([])
  expect(newServer.paths).toEqual(['/api/docs'])
})

test.each([
  [{ exitCode: 1, signalCode: null }, '1'],
  [{ exitCode: null, signalCode: 'SIGTERM' }, 'SIGTERM'],
])('fails immediately when the Python process exits before binding', async (child, status) => {
  const path = await logFile(startupLine(12345))

  await expect(waitForUvicornReady(child, path, { timeoutMs: 1000 })).rejects.toThrow(
    `Process exited with ${status}`
  )
})

test('rejects a startup log that still reports the unbound port zero', async () => {
  const path = await logFile(startupLine(0))

  await expect(waitForUvicornReady(running(), path, { timeoutMs: 1000 })).rejects.toThrow(
    'Uvicorn did not report a bound TCP port: 0'
  )
})

test('does not treat an old startup line as readiness when the restart never binds', async () => {
  const oldLog = startupLine(12345)
  const path = await logFile(oldLog)

  await expect(
    waitForUvicornReady(running(), path, { fromOffset: oldLog.length, timeoutMs: 20 })
  ).rejects.toThrow('Timed out waiting for')
})

test.each([false, true])(
  'holds the gateway port and releases it even on failure=%s',
  async fail => {
    let gatewayPort
    const action = withBackendGatewayPortLease(0, async port => {
      gatewayPort = port
      const { port: pythonPort } = await serveDocs()
      expect(pythonPort).not.toBe(port)
      const socket = connect(port, '127.0.0.1')
      await once(socket, 'close')
      if (fail) throw new Error('Python exited before binding')
    })
    if (fail) await expect(action).rejects.toThrow('Python exited before binding')
    else await action

    const gateway = createServer()
    gateway.listen(gatewayPort, '127.0.0.1')
    await once(gateway, 'listening')
    await new Promise(resolve => gateway.close(resolve))
  }
)
