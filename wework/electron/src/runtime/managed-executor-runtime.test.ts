import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  prepareManagedExecutorEnvironment,
  waitForEndpointAuthentication,
} from './managed-executor-runtime.js'
import { temporaryDirectory } from './test-helpers.js'

describe('managed executor runtime', () => {
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
})
