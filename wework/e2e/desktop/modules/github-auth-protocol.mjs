// User-authorized external GitHub protocol simulation; gh and Wework stay real.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
export const GITHUB_PROTOCOL_SYNC_TOKEN = 'wegent-e2e-synced-protocol-token'
const NATIVE_TOKEN = 'wegent-e2e-native-protocol-token'
const PULLS_PATH = '/repos/wecode-ai/Wegent/pulls'
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

export async function createGithubAuthProtocol({ resultDir }) {
  const directory = join(resultDir, 'github-protocol')
  await mkdir(directory, { recursive: true })
  // gh's documented Unix transport avoids system trust-store changes on macOS.
  // Keep the socket path short enough for sockaddr_un on both CI and macOS.
  const socketDirectory = await mkdtemp(join(tmpdir(), 'gh-auth-'))
  const socketPath = join(socketDirectory, 'http.sock')
  const state = {
    deviceMode: 'normal',
    approved: false,
    apiFailure: false,
    syncedValid: true,
    requests: [],
  }
  const sockets = new Set()
  const json = (response, status, body) => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'x-oauth-scopes': 'repo, read:org, gist',
    })
    response.end(JSON.stringify(body))
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'https://github.com').pathname
    const token = (request.headers.authorization ?? '').replace(/^(token|bearer) /i, '')
    const account =
      token === NATIVE_TOKEN
        ? 'native'
        : token === GITHUB_PROTOCOL_SYNC_TOKEN && state.syncedValid
          ? 'synced'
          : null
    state.requests.push({ method: request.method, path, account })
    request.resume()
    if (path === '/login/device/code') {
      if (state.deviceMode === 'timeout') return
      return json(response, 200, {
        device_code: 'wegent-device',
        user_code: state.deviceMode === 'missing-code' ? '' : 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 600,
        interval: 1,
      })
    }
    if (path === '/login/oauth/access_token') {
      return json(
        response,
        200,
        state.approved
          ? { access_token: NATIVE_TOKEN, token_type: 'bearer', scope: 'repo,read:org,gist' }
          : { error: 'authorization_pending' }
      )
    }
    if (path === PULLS_PATH)
      return json(response, account ? 200 : 401, account ? [] : { message: 'Bad credentials' })
    if (path === '/user' || path === '/graphql' || path === '/') {
      const send = () => {
        if (state.apiFailure) return json(response, 503, { message: 'Protocol transport failure' })
        if (!account) return json(response, 401, { message: 'Bad credentials' })
        const user = { login: `wegent-e2e-${account}`, id: account === 'native' ? 701 : 702 }
        return json(
          response,
          200,
          path === '/graphql' ? { data: { viewer: { login: user.login } } } : user
        )
      }
      if (path === '/user' && state.userGate?.account === account) {
        const gate = state.userGate
        delete state.userGate
        gate.entered = true
        gate.release = send
        return
      }
      return send()
    }
    return json(response, 404, { message: `Unexpected GitHub protocol path: ${path}` })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  const log = join(directory, 'processes.jsonl')
  await writeFile(log, '')
  const { stdout } = await run('which', ['gh'])
  const gh = stdout.trim()
  const processModule = fileURLToPath(new URL('./github-auth-process.mjs', import.meta.url))
  const wrap = async (name, kind, binary) => {
    const wrapper = join(directory, name)
    const args = [process.execPath, processModule, kind, binary, log]
    await writeFile(wrapper, `#!/bin/sh\nexec ${args.map(quote).join(' ')} "$@"\n`, { mode: 0o755 })
    return wrapper
  }
  await wrap('gh', 'gh', gh)
  return {
    state,
    directory,
    log,
    socketPath,
    gatePath: join(directory, 'command-gate.json'),
    holdNextUser(account) {
      const gate = { account, entered: false }
      state.userGate = gate
      return gate
    },
    async prepareApp({ appEnvironment }) {
      const native = appEnvironment.GH_CONFIG_DIR
      await writeFile(
        join(native, 'config.yml'),
        `http_unix_socket: ${JSON.stringify(socketPath)}\n`
      )
      appEnvironment.WEWORK_E2E_GITHUB_SOCKET = socketPath
      appEnvironment.WEWORK_E2E_GITHUB_GATE = this.gatePath
      appEnvironment.WEWORK_RUNTIME_BIN = [directory, appEnvironment.WEWORK_RUNTIME_BIN]
        .filter(Boolean)
        .join(delimiter)
      const node = join(directory, 'node')
      await writeFile(node, `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 })
      appEnvironment.WEWORK_NODE_PATH = node
      const codex = await wrap('codex-observed', 'codex', appEnvironment.CODEX_BINARY_PATH)
      appEnvironment.CODEX_BINARY_PATH = codex
      appEnvironment.CODEX_BIN = codex
    },
    async processes() {
      return (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
    },
    async cleanup() {
      await writeFile(
        join(resultDir, 'github-auth-protocol-diagnostics.json'),
        JSON.stringify(
          {
            protocolIntegration: true,
            processes: await this.processes(),
            requests: state.requests,
          },
          null,
          2
        )
      )
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      await rm(socketDirectory, { recursive: true, force: true })
      assert.ok(
        state.requests.every(request =>
          [
            '/user',
            '/graphql',
            '/',
            '/login/device/code',
            '/login/oauth/access_token',
            PULLS_PATH,
          ].includes(request.path)
        ),
        'Unexpected GitHub protocol request'
      )
    },
  }
}
