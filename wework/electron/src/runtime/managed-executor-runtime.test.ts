import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  ManagedExecutorRuntime,
  prepareManagedExecutorEnvironment,
  waitForEndpointAuthentication,
} from './managed-executor-runtime.js'
import { temporaryDirectory } from './test-helpers.js'

describe('managed executor runtime', () => {
  test('reuses the Tauri executor home by default', () => {
    const environment = prepareManagedExecutorEnvironment({
      dataDirectory: '/unused-electron-data',
      environment: {
        VITE_WEWORK_E2E: 'true',
      },
    })

    expect(environment.WEGENT_EXECUTOR_HOME).toBe(join(homedir(), '.wework'))
    expect(environment.WEGENT_CODEX_HOME).toBe(join(homedir(), '.wework', 'codex'))
    expect(environment.CODEX_HOME).toBe(join(homedir(), '.wework', 'codex'))
  })

  test('isolates Codex home and imports auth from the configured user home', async () => {
    const directory = await temporaryDirectory('managed-executor-environment-')
    const nativeCodexHome = join(directory.path, 'native-codex')
    const managedCodexHome = join(directory.path, 'managed-codex')
    await mkdir(nativeCodexHome, { recursive: true })
    await writeFile(join(nativeCodexHome, 'auth.json'), '{"auth":"native"}\n')

    const environment = prepareManagedExecutorEnvironment({
      dataDirectory: join(directory.path, 'data'),
      environment: {
        CODEX_HOME: '/must-not-leak',
        VITE_WEWORK_E2E: 'true',
        WEWORK_E2E_NATIVE_CODEX_HOME: nativeCodexHome,
        WEGENT_CODEX_HOME: managedCodexHome,
        WEGENT_EXECUTOR_HOME: join(directory.path, 'executor'),
      },
    })

    expect(environment.CODEX_HOME).toBe(managedCodexHome)
    expect(environment.WEGENT_CODEX_HOME).toBe(managedCodexHome)
    expect(await readFile(join(managedCodexHome, 'auth.json'), 'utf8')).toBe('{"auth":"native"}\n')
    await directory.remove()
  })

  test('does not leak the launching Codex auth into an isolated E2E home', async () => {
    const directory = await temporaryDirectory('managed-executor-blank-auth-')
    const launchingCodexHome = join(directory.path, 'launching-codex')
    const managedCodexHome = join(directory.path, 'managed-codex')
    await mkdir(launchingCodexHome, { recursive: true })
    await writeFile(join(launchingCodexHome, 'auth.json'), '{"auth":"launching"}\n')

    const environment = prepareManagedExecutorEnvironment({
      dataDirectory: join(directory.path, 'data'),
      environment: {
        CODEX_HOME: launchingCodexHome,
        VITE_WEWORK_E2E: 'true',
        WEGENT_CODEX_HOME: managedCodexHome,
      },
    })

    expect(environment.CODEX_HOME).toBe(managedCodexHome)
    await expect(readFile(join(managedCodexHome, 'auth.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await directory.remove()
  })

  test('waits for a credentialed local endpoint handshake', async () => {
    const directory = await temporaryDirectory('managed-executor-')
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\managed-executor-${process.pid}-${Date.now()}`
        : `${directory.path}/executor.sock`
    const token = '0123456789abcdef0123456789abcdef'
    const server = createServer(socket => {
      socket.setEncoding('utf8')
      socket.once('data', line => {
        const message = JSON.parse(line) as {
          type: string
          protocol_version: number
          token: string
        }
        socket.write(
          `${JSON.stringify({
            type: 'authenticated',
            ok:
              message.type === 'authenticate' &&
              message.protocol_version === 1 &&
              message.token === token,
            protocol_version: 1,
          })}\n`
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    try {
      await expect(
        waitForEndpointAuthentication(endpoint, token, AbortSignal.timeout(1_000))
      ).resolves.toBeUndefined()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await directory.remove()
    }
  })

  test('reconnects the owner stream after the executor restarts', async () => {
    const directory = await temporaryDirectory('managed-executor-restart-')
    const ownerConnectionsPath = join(directory.path, 'owner-connections')
    const runtime = new ManagedExecutorRuntime({
      command: process.execPath,
      args: [
        '-e',
        `
          const net = require('node:net')
          const fs = require('node:fs')
          const endpoint = process.env.WEGENT_APP_IPC_ENDPOINT
          const ownerConnectionsPath = process.argv[1]
          if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true })
          net.createServer(socket => {
            socket.setEncoding('utf8')
            socket.once('data', line => {
              const message = JSON.parse(line)
              const accepted =
                message.token === process.env.WEGENT_APP_IPC_TOKEN ||
                message.token === process.env.WEGENT_APP_IPC_OWNER_TOKEN
              if (message.token === process.env.WEGENT_APP_IPC_OWNER_TOKEN) {
                fs.appendFileSync(ownerConnectionsPath, 'connected\\n')
              }
              socket.write(JSON.stringify({
                type: 'authenticated',
                ok: accepted,
                protocol_version: 1,
              }) + '\\n')
            })
          }).listen(endpoint)
        `,
        ownerConnectionsPath,
      ],
      environment: {
        VITE_WEWORK_E2E: 'true',
        WEGENT_EXECUTOR_HOME: join(directory.path, 'executor-home'),
      },
      dataDirectory: join(directory.path, 'data'),
      logDirectory: join(directory.path, 'logs'),
      deviceId: 'test-device',
    })

    try {
      await runtime.start()
      const firstPid = runtime.pid()
      expect(firstPid).not.toBeNull()
      process.kill(firstPid!, 'SIGKILL')

      await expect
        .poll(
          async () =>
            (await readFile(ownerConnectionsPath, 'utf8')).split('\n').filter(Boolean).length,
          { timeout: 5_000 }
        )
        .toBe(2)
    } finally {
      await runtime.stop()
      await directory.remove()
    }
  })
})
