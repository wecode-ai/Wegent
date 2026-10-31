import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const execute = promisify(execFile)

test('prebuilt desktop wire client runs without workspace dependencies', async () => {
  const weworkDir = resolve(import.meta.dirname, '../..')
  const directory = await mkdtemp(join(tmpdir(), 'wework-e2e-client-'))
  try {
    const bundleDir = join(directory, 'e2e-client')
    await execute(process.execPath, [
      join(weworkDir, 'scripts/build-desktop-e2e-client.mjs'),
      bundleDir,
    ])
    await cp(join(weworkDir, 'e2e/desktop'), join(directory, 'wework/e2e/desktop'), {
      recursive: true,
    })
    await mkdir(join(directory, 'wework/scripts/lib'), { recursive: true })
    await cp(
      join(weworkDir, 'scripts/lib/desktop-package-target.mjs'),
      join(directory, 'wework/scripts/lib/desktop-package-target.mjs')
    )
    // CI reads these runtime files from its checkout without installing workspace packages.
    for (const runtimePath of [
      'packages/chat-core/package.json',
      'packages/chat-core/src/runtime-user-message.js',
      'packages/chat-core/test-fixtures/conversation-search-contract.json',
    ]) {
      await cp(resolve(weworkDir, '..', runtimePath), join(directory, runtimePath))
    }
    const { stdout } = await execute(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import assert from 'node:assert/strict'
          import { once } from 'node:events'
          import { createServer } from 'node:http'
          import { createRequire } from 'node:module'
          import { main } from './wework/e2e/desktop/modules/task-flow-main.mjs'
          import { verifyTerminalWireCompatibility } from './wework/e2e/desktop/modules/terminal-compatibility-flows.mjs'

          const require = createRequire(import.meta.url)
          assert.throws(() => require.resolve('socket.io-client'), { code: 'MODULE_NOT_FOUND' })
          assert.equal(typeof main, 'function')
          assert.equal(typeof verifyTerminalWireCompatibility, 'function')
          const { io } = require(process.env.WEWORK_E2E_SOCKET_IO_CLIENT)
          process.env.WEWORK_E2E_SOCKET_IO_CLIENT += '.missing'
          await assert.rejects(verifyTerminalWireCompatibility({}, {}), { code: 'MODULE_NOT_FOUND' })
          const server = createServer((_request, response) => response.writeHead(400).end())
          server.listen(0, '127.0.0.1')
          await once(server, 'listening')
          const socket = io('http://127.0.0.1:' + server.address().port + '/terminal', {
            transports: ['websocket'], autoConnect: false, reconnection: false,
          })
          try {
            const failed = once(socket, 'connect_error')
            socket.connect()
            const [error] = await failed
            assert.equal(error.message, 'websocket error')
            assert.equal(error.description.message, 'Unexpected server response: 400')
            console.log('isolated-client-passed')
          } finally {
            socket.disconnect()
            server.closeAllConnections()
            await new Promise(resolve => server.close(resolve))
          }
        `,
      ],
      {
        cwd: directory,
        timeout: 10_000,
        env: {
          ...process.env,
          NODE_PATH: '',
          WEWORK_E2E_SOCKET_IO_CLIENT: join(bundleDir, 'socket.io-client.cjs'),
        },
      }
    )
    expect(stdout).toContain('isolated-client-passed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
