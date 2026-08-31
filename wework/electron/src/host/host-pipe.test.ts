import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { describe, expect, test, vi } from 'vitest'
import type { AppUpdateService } from './app-update-service.js'
import { HostCapabilityRouter } from './capability-router.js'
import { registerAppUpdateCapabilities } from './electron-capabilities.js'
import { HostPipeServer } from './host-pipe.js'

describe('HostPipeServer', () => {
  test('requires a versioned handshake and returns capability responses', async () => {
    const router = new HostCapabilityRouter()
    router.grant('@wegent/dsh-app-wework', ['window.getState'])
    router.register('window.getState', async () => ({ maximized: false }))
    const server = new HostPipeServer(router)
    const childToHost = new PassThrough()
    const hostToChild = new PassThrough()
    const replies = createInterface({ input: hostToChild })
    const nextReply = () =>
      new Promise<Record<string, unknown>>(resolve =>
        replies.once('line', line => resolve(JSON.parse(line) as Record<string, unknown>))
      )
    server.attachStreams(childToHost, hostToChild)

    const hello = nextReply()
    childToHost.write(
      `${JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        token: server.environment().WEWORK_ELECTRON_HOST_TOKEN,
        principal: '@wegent/dsh-app-wework',
      })}\n`
    )
    await expect(hello).resolves.toEqual({
      type: 'hello',
      ok: true,
      protocolVersion: 1,
      capabilities: ['window.getState'],
    })

    const response = nextReply()
    childToHost.write(
      `${JSON.stringify({
        type: 'request',
        id: 'request-1',
        capability: 'window.getState',
        params: {},
      })}\n`
    )
    await expect(response).resolves.toEqual({
      type: 'response',
      id: 'request-1',
      ok: true,
      result: { maximized: false },
    })
    server.stop()
  })

  test('returns structured denial errors for ungranted principals', async () => {
    const router = new HostCapabilityRouter()
    router.register('window.close', vi.fn())
    const server = new HostPipeServer(router)
    const childToHost = new PassThrough()
    const hostToChild = new PassThrough()
    const replies = createInterface({ input: hostToChild })
    const read = () =>
      new Promise<Record<string, unknown>>(resolve =>
        replies.once('line', line => resolve(JSON.parse(line) as Record<string, unknown>))
      )
    server.attachStreams(childToHost, hostToChild)

    let reply = read()
    childToHost.write(
      `${JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        token: server.environment().WEWORK_ELECTRON_HOST_TOKEN,
        principal: '@third-party/app',
      })}\n`
    )
    await reply
    reply = read()
    childToHost.write(
      `${JSON.stringify({
        type: 'request',
        id: 'request-2',
        capability: 'window.close',
        params: {},
      })}\n`
    )
    await expect(reply).resolves.toMatchObject({
      type: 'response',
      id: 'request-2',
      ok: false,
      error: { code: 'capability_denied' },
    })
    server.stop()
  })

  test('writes the install response before running application shutdown', async () => {
    const router = new HostCapabilityRouter()
    router.grant('@wegent/dsh-app-wework', ['appUpdate.install'])
    const prepareShutdown = vi.fn(async () => server.stop())
    const quitAndInstall = vi.fn()
    const appUpdates = {
      createInstallAction: vi.fn(() => async () => {
        await prepareShutdown()
        quitAndInstall(false, true)
      }),
    } as unknown as AppUpdateService
    registerAppUpdateCapabilities(router, appUpdates)
    const server = new HostPipeServer(router)
    const childToHost = new PassThrough()
    const hostToChild = new PassThrough()
    const replies = createInterface({ input: hostToChild })
    const nextReply = () =>
      new Promise<Record<string, unknown>>(resolve =>
        replies.once('line', line => resolve(JSON.parse(line) as Record<string, unknown>))
      )
    server.attachStreams(childToHost, hostToChild)

    let response = nextReply()
    childToHost.write(
      `${JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        token: server.environment().WEWORK_ELECTRON_HOST_TOKEN,
        principal: '@wegent/dsh-app-wework',
      })}\n`
    )
    await response

    response = nextReply()
    childToHost.write(
      `${JSON.stringify({
        type: 'request',
        id: 'install-request',
        capability: 'appUpdate.install',
        params: {},
      })}\n`
    )

    await expect(response).resolves.toEqual({
      type: 'response',
      id: 'install-request',
      ok: true,
      result: null,
    })
    await vi.waitFor(() => {
      expect(prepareShutdown).toHaveBeenCalledOnce()
      expect(quitAndInstall).toHaveBeenCalledWith(false, true)
    })
  })

  test('rejects incompatible or unauthenticated handshakes', async () => {
    const server = new HostPipeServer(new HostCapabilityRouter())
    const childToHost = new PassThrough()
    const hostToChild = new PassThrough()
    const protocolError = vi.fn()
    server.on('protocolError', protocolError)
    server.attachStreams(childToHost, hostToChild)

    childToHost.write(
      `${JSON.stringify({
        type: 'hello',
        protocolVersion: 999,
        token: 'wrong',
        principal: '@wegent/dsh-app-wework',
      })}\n`
    )
    await vi.waitFor(() => expect(protocolError).toHaveBeenCalledOnce())
  })

  test('uses inherited file descriptors with a real child process', async () => {
    const router = new HostCapabilityRouter()
    router.grant('@wegent/dsh-app-wework', ['app.getVersion'])
    router.register('app.getVersion', () => ({ version: 'test-version' }))
    const server = new HostPipeServer(router)
    const script = `
      const fs = require('node:fs')
      const readline = require('node:readline')
      const input = fs.createReadStream(null, {
        fd: Number(process.env.WEWORK_ELECTRON_HOST_REQUEST_FD),
        autoClose: false,
      })
      const output = fs.createWriteStream(null, {
        fd: Number(process.env.WEWORK_ELECTRON_HOST_RESPONSE_FD),
        autoClose: false,
      })
      const lines = readline.createInterface({ input })
      const send = message => output.write(JSON.stringify(message) + '\\n')
      send({
        type: 'hello',
        protocolVersion: Number(process.env.WEWORK_ELECTRON_HOST_PROTOCOL),
        token: process.env.WEWORK_ELECTRON_HOST_TOKEN,
        principal: '@wegent/dsh-app-wework',
      })
      lines.on('line', line => {
        const message = JSON.parse(line)
        if (message.type === 'hello') {
          send({
            type: 'request',
            id: 'real-child-request',
            capability: 'app.getVersion',
            params: {},
          })
          return
        }
        process.stdout.write(JSON.stringify(message))
        process.exit(message.ok ? 0 : 1)
      })
    `
    const child = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, ...server.environment() },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    server.attach(child)

    try {
      const [code] = await once(child, 'exit')
      expect(code, stderr).toBe(0)
      expect(JSON.parse(stdout)).toEqual({
        type: 'response',
        id: 'real-child-request',
        ok: true,
        result: { version: 'test-version' },
      })
    } finally {
      server.stop()
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  })
})
