import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const DESKTOP_READY_TIMEOUT_MS = 60_000
const WORKBENCH_READY_TIMEOUT_MS = 180_000
const UI_TIMEOUT_MS = 120_000
const PROCESS_STOP_TIMEOUT_MS = 10_000
const TASK_PROMPT = 'WEWORK_DESKTOP_E2E_TASK: create the requested verification file.'
const COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_COMPLETE'
const ARTIFACT_NAME = 'wework-e2e-result.txt'
const ARTIFACT_CONTENT = 'CODEX_EXECUTED_REAL_TOOL'
const MODEL_API_KEY = 'wework-e2e-test-key'
const MODEL_PROVIDER_ID = 'wework-e2e'
const MODEL_ID = 'gpt-5.4'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..', '..')
const repoDir = resolve(weworkDir, '..')
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const resultDir = join(weworkDir, 'test-results', 'desktop-e2e', runId)

function withTimeout(promise, timeoutMs, message) {
  let timeout
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}: ${result.stderr || result.stdout}`
    )
  }
  return result.stdout.trim()
}

async function runChecked(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`)
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'unknown status'}`))
    })
  })
}

async function resolveExecutable(configuredPath, fallbackCommand, description) {
  const candidate = configuredPath?.trim()
  if (candidate) {
    const absolutePath = resolve(candidate)
    assert.equal(
      await isExecutable(absolutePath),
      true,
      `${description} is not executable: ${absolutePath}`
    )
    return absolutePath
  }

  const resolved = commandOutput('which', [fallbackCommand])
  assert.equal(await isExecutable(resolved), true, `${description} is not executable: ${resolved}`)
  return resolved
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return withTimeout(
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    timeoutMs,
    `Timed out waiting for process ${child.pid ?? 'unknown'} to exit`
  )
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
  } catch {
    child.kill('SIGKILL')
    await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
  }
}

async function appendProcessOutput(stream, destination) {
  if (!stream) return
  stream.on('data', chunk => {
    void appendFile(destination, chunk)
  })
}

async function fillComposerUntilSendEnabled(control, selector) {
  let lastError
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await control.command('fill', selector, { value: TASK_PROMPT })
    try {
      await control.command('waitFor', '[data-testid="send-message-button"]', {
        enabled: true,
        timeoutMs: 3_000,
      })
      return
    } catch (error) {
      lastError = error
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
  }
  throw lastError
}

function createSse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function responseCompleted(id) {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  }
}

function functionCall(callId, name, argumentsValue) {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: callId,
      name,
      arguments: JSON.stringify(argumentsValue),
    },
  }
}

function assistantMessage(text) {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'message',
      role: 'assistant',
      id: 'wework-e2e-message',
      content: [{ type: 'output_text', text }],
    },
  }
}

function readRequestBody(request) {
  return new Promise((resolvePromise, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
    })
    request.once('end', () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.once('error', reject)
  })
}

function json(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(`${JSON.stringify(value)}\n`)
}

function cors(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function requestContainsToolOutput(request) {
  return JSON.stringify(request.input ?? []).includes('function_call_output')
}

function selectShellTool(request, workspacePath) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  const names = new Set(tools.map(tool => tool?.name).filter(Boolean))
  const command = `printf '%s\\n' '${ARTIFACT_CONTENT}' > ${ARTIFACT_NAME}`

  if (names.has('exec_command')) {
    return {
      name: 'exec_command',
      arguments: { cmd: command, workdir: workspacePath, yield_time_ms: 1000 },
    }
  }
  if (names.has('shell_command')) {
    return {
      name: 'shell_command',
      arguments: { command, workdir: workspacePath, timeout_ms: 10_000 },
    }
  }
  throw new Error(`Real Codex did not advertise a supported shell tool: ${[...names].join(', ')}`)
}

class DesktopE2EServer {
  constructor(workspacePath) {
    this.workspacePath = workspacePath
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
    this.ready = null
    this.readyResolver = null
    this.commandQueue = []
    this.commandWaiters = []
    this.commandResults = new Map()
    this.modelRequests = []
    this.modelStage = 'initial'
    this.toolOutput = null
  }

  async start() {
    await new Promise((resolvePromise, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolvePromise()
      })
    })
    const address = this.server.address()
    assert.ok(address && typeof address !== 'string', 'Desktop E2E server did not bind a TCP port')
    this.url = `http://127.0.0.1:${address.port}`
  }

  async close() {
    for (const waiter of this.commandWaiters.splice(0)) {
      json(waiter, 503, { error: 'Desktop E2E server is shutting down' })
    }
    await new Promise(resolvePromise => this.server.close(resolvePromise))
  }

  awaitReady() {
    if (this.ready) return Promise.resolve(this.ready)
    return new Promise(resolvePromise => {
      this.readyResolver = resolvePromise
    })
  }

  async command(action, selector, options = {}) {
    const id = randomUUID()
    const command = { id, action, selector, ...options }
    const result = new Promise((resolvePromise, reject) => {
      this.commandResults.set(id, { resolve: resolvePromise, reject })
    })
    this.commandQueue.push(command)
    this.flushCommandWaiter()
    return withTimeout(
      result,
      options.timeoutMs ?? UI_TIMEOUT_MS,
      `Timed out running UI action ${action}`
    )
  }

  flushCommandWaiter() {
    if (this.commandQueue.length === 0 || this.commandWaiters.length === 0) return
    const command = this.commandQueue.shift()
    const response = this.commandWaiters.shift()
    json(response, 200, command)
  }

  async handle(request, response) {
    cors(response)
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', this.url)
    if (request.method === 'POST' && url.pathname === '/ready') {
      const ready = await readRequestBody(request)
      this.ready = ready
      this.readyResolver?.(ready)
      this.readyResolver = null
      json(response, 200, { ok: true })
      return
    }

    if (request.method === 'GET' && url.pathname === '/commands') {
      if (this.commandQueue.length > 0) {
        json(response, 200, this.commandQueue.shift())
        return
      }
      this.commandWaiters.push(response)
      response.once('close', () => {
        const index = this.commandWaiters.indexOf(response)
        if (index >= 0) this.commandWaiters.splice(index, 1)
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/results') {
      const result = await readRequestBody(request)
      const pending = this.commandResults.get(result.id)
      if (!pending) {
        json(response, 404, { error: `Unknown command ${result.id}` })
        return
      }
      this.commandResults.delete(result.id)
      if (result.ok) {
        pending.resolve(result.value ?? '')
      } else {
        pending.reject(new Error(result.error ?? `UI action ${result.id} failed`))
      }
      json(response, 200, { ok: true })
      return
    }

    if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      json(response, 200, {
        object: 'list',
        data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: MODEL_PROVIDER_ID }],
      })
      return
    }

    if (
      request.method === 'POST' &&
      (url.pathname === '/v1/responses' || url.pathname === '/responses')
    ) {
      await this.handleModelResponse(request, response)
      return
    }

    json(response, 404, { error: `No Desktop E2E route for ${request.method} ${url.pathname}` })
  }

  async handleModelResponse(request, response) {
    const body = await readRequestBody(request)
    const authorization = request.headers.authorization ?? null
    this.modelRequests.push({ authorization, body })
    if (authorization !== `Bearer ${MODEL_API_KEY}`) {
      json(response, 401, { error: 'The Desktop E2E model API key was not forwarded by Codex' })
      return
    }

    const responseId = `wework-e2e-response-${this.modelRequests.length}`
    let events
    if (this.modelStage === 'initial') {
      assert.ok(
        JSON.stringify(body).includes(TASK_PROMPT),
        'The real Codex request did not contain the UI task prompt'
      )
      const tool = selectShellTool(body, this.workspacePath)
      this.modelStage = 'awaiting_tool_output'
      events = [
        responseCreated(responseId),
        functionCall('wework-e2e-tool-call', tool.name, tool.arguments),
        responseCompleted(responseId),
      ]
    } else {
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The real Codex request did not report its tool output to the model service'
      )
      this.toolOutput = JSON.stringify(body.input)
      this.modelStage = 'complete'
      events = [
        responseCreated(responseId),
        assistantMessage(COMPLETION_TEXT),
        responseCompleted(responseId),
      ]
    }

    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.end(createSse(events))
  }
}

async function writeCodexConfig(codexHome, modelServerUrl) {
  await mkdir(codexHome, { recursive: true })
  await writeFile(
    join(codexHome, 'config.toml'),
    `model_provider = "${MODEL_PROVIDER_ID}"\nmodel = "${MODEL_ID}"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n\n[model_providers.${MODEL_PROVIDER_ID}]\nname = "Wework Desktop E2E"\nbase_url = "${modelServerUrl}/v1"\nenv_key = "WEWORK_E2E_MODEL_API_KEY"\nwire_api = "responses"\n`,
    'utf8'
  )
}

async function buildExecutor() {
  const configured = process.env.WEWORK_E2E_EXECUTOR_BIN
  if (configured)
    return resolveExecutable(configured, 'wegent-executor', 'Configured Wework executor')

  await runChecked('cargo', ['build', '--locked', '--bin', 'wegent-executor'], {
    cwd: join(repoDir, 'executor'),
  })
  const binaryName = process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
  const binaryPath = join(repoDir, 'executor', 'target', 'debug', binaryName)
  assert.equal(await isExecutable(binaryPath), true, `Executor build did not produce ${binaryPath}`)
  return binaryPath
}

async function buildDesktopApp(controlUrl, appIdentifier) {
  const configured = process.env.WEWORK_E2E_APP_BIN
  if (configured) return resolveExecutable(configured, 'app', 'Configured Wework desktop app')

  await runChecked(
    'pnpm',
    [
      'exec',
      'tauri',
      'build',
      '--debug',
      '--no-bundle',
      '--config',
      JSON.stringify({ identifier: appIdentifier }),
    ],
    {
      cwd: weworkDir,
      env: {
        ...process.env,
        VITE_WEWORK_DESKTOP_E2E_CONTROL_URL: controlUrl,
        VITE_WEWORK_E2E: 'true',
        VITE_WEWORK_RUNTIME_MODE: 'local-first',
      },
    }
  )
  const binaryName = process.platform === 'win32' ? 'app.exe' : 'app'
  const candidates = [
    join(weworkDir, 'src-tauri', 'target', 'debug', binaryName),
    join(
      weworkDir,
      'src-tauri',
      'target',
      'debug',
      'bundle',
      'macos',
      'WeWork.app',
      'Contents',
      'MacOS',
      binaryName
    ),
  ]
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate
  }
  throw new Error(
    `Tauri build did not produce an executable app. Checked: ${candidates.join(', ')}`
  )
}

async function main() {
  await mkdir(resultDir, { recursive: true })
  const workspacePath = join(resultDir, 'workspace')
  const homePath = join(resultDir, 'home')
  const executorHome = join(resultDir, 'executor-home')
  const appLogPath = join(resultDir, 'app.log')
  const executorSocketPath = join(tmpdir(), `wework-e2e-${process.pid}.sock`)
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(homePath, { recursive: true }),
  ])

  const control = new DesktopE2EServer(workspacePath)
  let app
  try {
    await control.start()
    const codexBinary = await resolveExecutable(
      process.env.CODEX_BIN ?? process.env.CODEX_BINARY_PATH,
      'codex',
      'Codex binary'
    )
    const codexVersion = commandOutput(codexBinary, ['--version'])
    assert.ok(codexVersion.length > 0, 'Real Codex did not return a version')
    console.log(`Using real Codex: ${codexVersion}`)

    const appIdentifier = `io.wecode.wework.e2e.run${process.pid}`
    const [executorBinary, appBinary] = await Promise.all([
      buildExecutor(),
      buildDesktopApp(control.url, appIdentifier),
    ])
    await writeCodexConfig(join(executorHome, 'codex'), control.url)

    app = spawn(
      appBinary,
      ['--open-workspace', workspacePath, '--workspace-label', 'Desktop E2E'],
      {
        cwd: weworkDir,
        env: {
          ...process.env,
          CODEX_BIN: codexBinary,
          HOME: homePath,
          WEGENT_CODEX_HOME: join(executorHome, 'codex'),
          WEGENT_EXECUTOR_HOME: executorHome,
          WEGENT_EXECUTOR_APP_IPC_SOCKET: executorSocketPath,
          WEGENT_EXECUTOR_LOG_DIR: resultDir,
          WEGENT_EXECUTOR_LOG_FILE: 'executor.log',
          DEVICE_ID: `wework-e2e-device-${process.pid}`,
          WEWORK_E2E_MODEL_API_KEY: MODEL_API_KEY,
          WEWORK_EXECUTOR_SIDECAR: executorBinary,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    await Promise.all([
      appendProcessOutput(app.stdout, appLogPath),
      appendProcessOutput(app.stderr, appLogPath),
    ])

    const ready = await withTimeout(
      control.awaitReady(),
      DESKTOP_READY_TIMEOUT_MS,
      'Timed out waiting for the real Tauri application to connect to the Desktop E2E controller'
    )
    assert.match(
      String(ready.location ?? ''),
      /^(tauri|http):/,
      'The desktop controller did not connect from a webview'
    )

    const composerSelector = '[data-testid="chat-message-input"][contenteditable="true"]'
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await fillComposerUntilSendEnabled(control, composerSelector)
    await control.command('click', '[data-testid="send-message-button"]')
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })

    assert.equal(
      await readFile(join(workspacePath, ARTIFACT_NAME), 'utf8'),
      `${ARTIFACT_CONTENT}\n`,
      'The real Codex tool execution did not create the expected workspace artifact'
    )
    assert.equal(
      control.modelStage,
      'complete',
      'The model service did not complete the Codex tool loop'
    )
    assert.ok(control.modelRequests.length >= 2, 'The real Codex did not make both model requests')
    assert.ok(
      typeof control.modelRequests[0].body.model === 'string' &&
        control.modelRequests[0].body.model.length > 0,
      'The real Codex request did not select a model'
    )
    assert.ok(
      control.toolOutput,
      'Codex did not report its real tool execution to the model service'
    )

    await writeFile(
      join(resultDir, 'model-requests.json'),
      `${JSON.stringify(control.modelRequests, null, 2)}\n`,
      'utf8'
    )
    console.log(`Wework desktop task-flow E2E passed. Diagnostics: ${resultDir}`)
  } catch (error) {
    try {
      const snapshot = await control.command('snapshot', 'body', { timeoutMs: 5000 })
      await writeFile(join(resultDir, 'ui-snapshot.json'), `${snapshot}\n`, 'utf8')
    } catch {
      // Preserve the original test failure when the WebView can no longer answer diagnostics.
    }
    await writeFile(
      join(resultDir, 'failure.txt'),
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      'utf8'
    )
    throw error
  } finally {
    await stopProcess(app)
    await control.close()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})
