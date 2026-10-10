import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { stopProcessGroup } from '../process-lifecycle.mjs'

const SERVER_NAMES = ['first', 'second']
const HELPER_PATH = fileURLToPath(import.meta.url)
const TIMEOUT_MS = 10_000

function serveEnvironmentProbe(name, evidencePath, toolName) {
  assert.ok(SERVER_NAMES.includes(name))
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line)
    if (message.id === undefined) return
    let result
    switch (message.method) {
      case 'initialize':
        writeFileSync(
          evidencePath,
          JSON.stringify({
            name,
            pid: process.pid,
            token: process.env.TOKEN,
            apiKey: process.env.OPENAI_API_KEY,
            servicePath: process.env.PATH,
          }),
          { mode: 0o600 }
        )
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name, version: '1' },
        }
        break
      case 'tools/list':
        result = {
          tools: toolName
            ? [
                {
                  name: toolName,
                  description: 'Read the current synthetic MCP context',
                  inputSchema: { type: 'object', properties: {} },
                },
              ]
            : [],
        }
        break
      case 'tools/call':
        assert.equal(message.params.name, toolName)
        assert.ok(toolName)
        result = { content: [{ type: 'text', text: `MCP_CONTEXT:${process.env.TOKEN}` }] }
        break
      case 'resources/list':
        result = { resources: [] }
        break
      case 'resources/templates/list':
        result = { resourceTemplates: [] }
        break
      case 'ping':
        result = {}
        break
      default:
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } })}\n`
        )
        return
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
  })
}

function startNativeClient({ binary, args, cwd, env, root, phase }) {
  const child = spawn(binary, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const notifications = []
  let nextId = 0
  let failure
  function fail(error) {
    failure = error
    for (const item of pending.values()) {
      clearTimeout(item.timeout)
      item.reject(error)
    }
    pending.clear()
  }
  child.once('error', fail)
  child.once('exit', (code, signal) => fail(new Error(`Native Codex exited: ${code}/${signal}`)))
  child.stdin.on('error', fail)
  child.stderr.on('data', data => appendFileSync(join(root, `${phase}.stderr`), data))
  const input = createInterface({ input: child.stdout })
  input.on('line', line => {
    try {
      appendFileSync(join(root, `${phase}.rpc.jsonl`), `${line}\n`)
      const message = JSON.parse(line)
      if (message.method) notifications.push(message)
      const item = pending.get(message.id)
      if (!item) return
      clearTimeout(item.timeout)
      pending.delete(message.id)
      if (message.error) item.reject(new Error(JSON.stringify(message.error)))
      else item.resolve(message.result)
    } catch (error) {
      fail(error)
    }
  })
  return {
    child,
    call(method, params) {
      if (failure) return Promise.reject(failure)
      return new Promise((resolveCall, reject) => {
        const id = ++nextId
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out; evidence: ${root}`))
        }, TIMEOUT_MS)
        pending.set(id, { resolve: resolveCall, reject, timeout })
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      })
    },
    notify(method) {
      if (failure) throw failure
      child.stdin.write(`${JSON.stringify({ method, params: {} })}\n`)
    },
    async waitFor(method, predicate) {
      const deadline = Date.now() + TIMEOUT_MS
      while (Date.now() < deadline) {
        if (failure) throw failure
        const match = notifications.find(
          event => event.method === method && predicate(event.params)
        )
        if (match) return match.params
        await delay(20)
      }
      throw new Error(`${method} notification timed out; evidence: ${root}`)
    },
    async close() {
      try {
        await stopProcessGroup(child)
      } finally {
        input.close()
        fail(new Error('Native MCP environment fixture closed'))
      }
    },
  }
}

async function initialize(client) {
  const result = await client.call('initialize', {
    clientInfo: { name: 'wework_mcp_environment_e2e', version: '1' },
    capabilities: { experimentalApi: true },
  })
  client.notify('initialized')
  return result
}

function environmentFor(phase, name) {
  return {
    TOKEN: `synthetic-secret-${phase}-${name}`,
    OPENAI_API_KEY: `synthetic-key-${phase}-${name}`,
    PATH: `/synthetic/${phase}/${name}`,
    ELECTRON_RUN_AS_NODE: '1',
  }
}

async function assertServerEnvironments(client, root, phase) {
  const rows = []
  for (const name of SERVER_NAMES) {
    const startup = await client.waitFor(
      'mcpServer/startupStatus/updated',
      params => params.name === name && ['ready', 'failed', 'cancelled'].includes(params.status)
    )
    assert.equal(startup.status, 'ready', `${name} MCP failed startup: ${JSON.stringify(startup)}`)
    const row = JSON.parse(await readFile(join(root, `${name}.json`), 'utf8'))
    const expected = environmentFor(phase, name)
    assert.equal(row.name, name)
    assert.equal(row.token, expected.TOKEN, `${phase}: service-local TOKEN was lost`)
    assert.equal(row.apiKey, expected.OPENAI_API_KEY, `${phase}: service-local API key was lost`)
    assert.equal(row.servicePath, expected.PATH, `${phase}: service-local PATH was lost`)
    rows.push(row)
  }
  assert.notEqual(rows[0].token, rows[1].token)
  return rows
}

async function waitForRollout(path) {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      assert.equal((await lstat(path)).isFile(), true)
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await delay(20)
  }
  throw new Error('Native rollout was not persisted before process restart')
}

// Called by the CI-covered workbench-mode checkpoint, using its real native binary.
export async function verifyNativeMcpEnvironment({ fixture, resultDir }) {
  const workspaceSuffix = relative(resolve(resultDir), resolve(fixture.workspace))
  assert.ok(
    workspaceSuffix &&
      !isAbsolute(workspaceSuffix) &&
      workspaceSuffix !== '..' &&
      !workspaceSuffix.startsWith(`..${sep}`),
    'Native MCP workspace must belong to the isolated desktop fixture'
  )
  const root = await mkdtemp(join(resultDir, 'native-mcp-environment-'))
  const home = join(root, 'home')
  await mkdir(home, { mode: 0o700 })
  // Only OS launch variables cross this boundary; never inherit runner credentials or Homes.
  const env = Object.fromEntries(
    Object.entries(fixture.environment).filter(
      ([key, value]) => /^(path|systemroot|windir|comspec|pathext)$/i.test(key) && value != null
    )
  )
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: home,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
  })
  const config = {
    cli_auth_credentials_store: 'file',
    mcp_oauth_credentials_store: 'file',
    model: 'gpt-5.4',
    model_provider: 'synthetic',
    'model_providers.synthetic.name': 'Local environment contract',
    'model_providers.synthetic.base_url': 'http://127.0.0.1:9/v1',
    'model_providers.synthetic.wire_api': 'responses',
    'model_providers.synthetic.requires_openai_auth': false,
    'features.shell_snapshot': false,
  }
  for (const name of SERVER_NAMES) {
    config[`mcp_servers.${name}.command`] = process.execPath
    config[`mcp_servers.${name}.args`] = [
      HELPER_PATH,
      '--stdio-env-server',
      name,
      join(root, `${name}.json`),
    ]
  }
  const args = Object.entries(config)
    .flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])
    .concat('app-server')
  assert.equal(env.TOKEN, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.ok(!JSON.stringify(args).includes('synthetic-secret'))
  assert.ok(!JSON.stringify(args).includes('synthetic-key'))
  const params = phase => ({
    cwd: fixture.workspace,
    model: 'gpt-5.4',
    modelProvider: 'synthetic',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    config: {
      ...config,
      ...Object.fromEntries(
        SERVER_NAMES.map(name => [`mcp_servers.${name}.env`, environmentFor(phase, name)])
      ),
    },
  })
  let activeClient
  try {
    activeClient = startNativeClient({
      binary: fixture.codexBinary,
      args,
      cwd: fixture.workspace,
      env,
      root,
      phase: 'start',
    })
    const native = await initialize(activeClient)
    assert.equal(await realpath(native.codexHome), await realpath(home))
    const started = await activeClient.call('thread/start', {
      ...params('start'),
      ephemeral: false,
    })
    const start = await assertServerEnvironments(activeClient, root, 'start')
    // Empty threads are not persisted. Interrupt one native turn after it becomes
    // active; this needs no model response and cannot reach a personal model endpoint.
    const turn = await activeClient.call('turn/start', {
      threadId: started.thread.id,
      input: [{ type: 'text', text: 'Synthetic environment contract; no actions.' }],
    })
    await activeClient.waitFor('turn/started', event => event.turn.id === turn.turn.id)
    await activeClient.call('turn/interrupt', { threadId: started.thread.id, turnId: turn.turn.id })
    await activeClient.waitFor('turn/completed', event => event.turn.id === turn.turn.id)
    await waitForRollout(started.thread.path)
    await activeClient.call('thread/unsubscribe', { threadId: started.thread.id })
    await activeClient.close()
    activeClient = undefined
    assert.equal(
      (await lstat(started.thread.path)).isFile(),
      true,
      'Native rollout was not persisted'
    )

    activeClient = startNativeClient({
      binary: fixture.codexBinary,
      args,
      cwd: fixture.workspace,
      env,
      root,
      phase: 'resume',
    })
    const restarted = await initialize(activeClient)
    assert.equal(await realpath(restarted.codexHome), await realpath(home))
    const resumed = await activeClient.call('thread/resume', {
      ...params('resume'),
      threadId: started.thread.id,
      path: started.thread.path,
    })
    assert.equal(resumed.thread.id, started.thread.id, 'Native resume created a new conversation')
    const resume = await assertServerEnvironments(activeClient, root, 'resume')
    await assert.rejects(lstat(join(home, 'auth.json')), { code: 'ENOENT' })
    const evidence = {
      passed: true,
      native,
      thread: started.thread.id,
      start,
      resume,
      personalAuthentication: false,
    }
    await writeFile(join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    })
    return { evidencePath: join(root, 'evidence.json'), ...evidence }
  } finally {
    await activeClient?.close()
  }
}

if (resolve(process.argv[1] ?? '') === HELPER_PATH && process.argv[2] === '--stdio-env-server') {
  serveEnvironmentProbe(process.argv[3], process.argv[4], process.argv[5])
}
