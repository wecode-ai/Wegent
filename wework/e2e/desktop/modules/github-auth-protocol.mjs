// User-authorized external GitHub protocol simulation; gh and Wework stay real.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createSecureContext, TLSSocket } from 'node:tls'
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
  // macOS uses gh's Unix transport; Linux also covers the older distro gh
  // through a process-scoped TLS proxy. Neither changes the system trust store.
  const socketDirectory = await mkdtemp(join(tmpdir(), 'gh-auth-'))
  const socketPath = join(socketDirectory, 'http.sock')
  const transportEnvironment = {}
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
  if (process.platform === 'linux') {
    const cert = join(socketDirectory, 'github.crt')
    const key = join(socketDirectory, 'github.key')
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=github.com',
      '-addext',
      'subjectAltName=DNS:github.com,DNS:api.github.com',
      '-keyout',
      key,
      '-out',
      cert,
    ])
    const secureContext = createSecureContext({
      key: await readFile(key),
      cert: await readFile(cert),
    })
    server.on('connect', (request, socket, head) => {
      socket.on('error', () => socket.destroy())
      if (!['github.com:443', 'api.github.com:443'].includes(request.url)) {
        state.requests.push({ method: 'CONNECT', path: request.url, account: null })
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        return
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) socket.unshift(head)
      const secured = new TLSSocket(socket, { isServer: true, secureContext })
      secured.on('error', () => secured.destroy())
      server.emit('connection', secured)
    })
    transportEnvironment.WEWORK_E2E_GITHUB_CA = cert
  } else {
    transportEnvironment.WEWORK_E2E_GITHUB_SOCKET = socketPath
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    if (process.platform === 'linux') server.listen(0, '127.0.0.1', resolve)
    else server.listen(socketPath, resolve)
  })
  if (process.platform === 'linux')
    transportEnvironment.WEWORK_E2E_GITHUB_PROXY = `http://127.0.0.1:${server.address().port}`
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
    transportEnvironment,
    gatePath: join(directory, 'command-gate.json'),
    holdNextUser(account) {
      const gate = { account, entered: false }
      state.userGate = gate
      return gate
    },
    async prepareApp({ appEnvironment }) {
      const native = appEnvironment.GH_CONFIG_DIR
      if (transportEnvironment.WEWORK_E2E_GITHUB_SOCKET)
        await writeFile(
          join(native, 'config.yml'),
          `http_unix_socket: ${JSON.stringify(socketPath)}\n`
        )
      Object.assign(appEnvironment, transportEnvironment)
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
      // Fail before launching desktop if the installed gh bypasses the fixture.
      // This token is process-only: the scenario's credential profile stays empty.
      const probe = await run(
        join(directory, 'gh'),
        ['api', 'user', '--hostname', 'github.com', '--jq', '.login'],
        { env: { ...appEnvironment, GH_TOKEN: NATIVE_TOKEN }, timeout: 10_000 }
      )
      assert.equal(probe.stdout.trim(), 'wegent-e2e-native')
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
