import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { access, appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const DESKTOP_READY_TIMEOUT_MS = 60_000
const WORKBENCH_READY_TIMEOUT_MS = 180_000
const UI_TIMEOUT_MS = 120_000
const PROCESS_STOP_TIMEOUT_MS = 10_000
const COMPOSER_READY_STABILITY_MS = 750
const TASK_PROMPT = 'WEWORK_DESKTOP_E2E_TASK: create the requested verification file.'
const COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_COMPLETE'
const FOLLOW_UP_PROMPT = 'WEWORK_DESKTOP_E2E_FOLLOW_UP: confirm the completed task.'
const FOLLOW_UP_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_FOLLOW_UP_COMPLETE'
const REQUEST_USER_INPUT_PROMPT =
  'WEWORK_DESKTOP_E2E_REQUEST_INPUT: ask which implementation direction to use.'
const REQUEST_USER_INPUT_QUESTION = 'Which implementation direction should be used?'
const REQUEST_USER_INPUT_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_REQUEST_INPUT_COMPLETE'
const CANCELLATION_PROMPT = 'WEWORK_DESKTOP_E2E_CANCEL: wait until the response is cancelled.'
const CANCELLATION_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_CANCEL_COMPLETE'
const RETRY_PROMPT = 'WEWORK_DESKTOP_E2E_RETRY: fail once and then succeed after retry.'
const RETRY_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_RETRY_COMPLETE'
const ARTIFACT_NAME = 'wework-e2e-result.txt'
const ARTIFACT_CONTENT = 'CODEX_EXECUTED_REAL_TOOL'
const GIT_SEED_NAME = 'README.md'
const GIT_SEED_CONTENT = '# Desktop E2E workspace\n'
const MODEL_API_KEY = 'wework-e2e-test-key'
const MODEL_PROVIDER_ID = 'wework-e2e'
const MODEL_ID = 'gpt-5.4'
const MODEL_LABEL = 'GPT 5.4'
const DEFAULT_MODEL_ID = 'gpt-5.4-mini'
const DEFAULT_MODEL_LABEL = 'GPT 5.4 Mini'
const LOCAL_MODEL_ID = 'local-model:desktop-e2e-local'
const BLOCKED_CLOUD_MODEL_PATH = '/api/models/unified'
const FRESH_CHAT_PROMPT = 'WEWORK_DESKTOP_E2E_FRESH_CHAT: confirm this is a new conversation.'
const FRESH_CHAT_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_FRESH_CHAT_COMPLETE'
const ACTIVE_WORKBENCH_SELECTOR = '[data-testid="desktop-workbench-main"]'
const ACTIVE_COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const ACTIVE_SEND_BUTTON_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
const REQUEST_INPUT_ONLY = process.env.WEWORK_DESKTOP_E2E_REQUEST_INPUT_ONLY === '1'

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

async function sendPrompt(control, selector, prompt) {
  await control.command('fill', selector, { value: prompt })
  await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
}

async function waitForSnapshot(control, predicate, message, timeoutMs = UI_TIMEOUT_MS) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (predicate(snapshot)) return snapshot
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function captureVerificationScreenshot(control, name) {
  const screenshotPath = join(resultDir, name)
  if (process.platform === 'linux') {
    await runChecked('import', ['-window', 'root', screenshotPath])
    return screenshotPath
  }
  const dataUrl = await control.command('capture', 'body')
  const prefix = 'data:image/png;base64,'
  assert.ok(dataUrl.startsWith(prefix), 'Desktop screenshot did not return PNG data')
  await writeFile(screenshotPath, Buffer.from(dataUrl.slice(prefix.length), 'base64'))
  return screenshotPath
}

async function triggerModelReloadUntilCloudFailure(control) {
  const failedCloudModelRequest = control.awaitFailedCloudModelRequest()
  for (let attempt = 0; attempt < 10 && control.failedCloudModelRequests === 0; attempt += 1) {
    await control.command('dispatchLocalModelSettingsChanged', '')
    await Promise.race([
      failedCloudModelRequest,
      new Promise(resolvePromise => setTimeout(resolvePromise, 1_000)),
    ])
  }
  await withTimeout(
    failedCloudModelRequest,
    UI_TIMEOUT_MS,
    'The connected desktop app did not retry models after the cloud endpoint began failing'
  )
}

async function sendPromptUntilScenarioRequest(control, selector, prompt, scenario) {
  const scenarioRequest = control.awaitScenarioRequest(scenario)
  await sendPrompt(control, selector, prompt)
  return withTimeout(
    scenarioRequest,
    UI_TIMEOUT_MS,
    `The model service did not receive the ${scenario} request`
  )
}

async function selectE2EModel(control, modelId = MODEL_ID, modelLabel = MODEL_LABEL) {
  const selectedModelText = await control.command(
    'waitFor',
    '[data-testid="model-selector-button"]',
    {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    }
  )
  if (selectedModelText.includes(modelLabel)) return
  await control.command('clickWhenEnabled', '[data-testid="model-selector-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('hover', '[data-testid="model-control-menu-model"]', {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', `[data-testid="model-option-${modelId}"]`, {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('waitFor', `[data-testid="model-option-${LOCAL_MODEL_ID}"]`, {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="model-option-${modelId}"]`)
  await control.command('waitFor', '[data-testid="model-selector-button"]', {
    text: modelLabel,
    timeoutMs: UI_TIMEOUT_MS,
  })
}

function createSse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function codexRequestKind(body) {
  const metadata = body.client_metadata?.['x-codex-turn-metadata']
  if (typeof metadata !== 'string') return null

  try {
    return JSON.parse(metadata).request_kind ?? null
  } catch {
    return null
  }
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

function responseFailed(id, message) {
  return {
    type: 'response.failed',
    response: {
      id,
      status: 'failed',
      error: { code: 'context_length_exceeded', message },
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

function customToolCall(callId, name, input) {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'custom_tool_call',
      call_id: callId,
      name,
      input,
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

function requestAdvertisesShellTool(request) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  return tools.some(tool => tool?.name === 'exec_command' || tool?.name === 'shell_command')
}

function selectTool(request, name, argumentsValue) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  const names = new Set(tools.map(tool => tool?.name).filter(Boolean))
  assert.ok(names.has(name), `Real Codex did not advertise ${name}: ${[...names].join(', ')}`)
  return { name, arguments: argumentsValue }
}

function selectShellTool(request, workspacePath) {
  const command = 'pwd'
  const tools = Array.isArray(request.tools) ? request.tools : []
  if (tools.some(tool => tool?.name === 'exec_command')) {
    return selectTool(request, 'exec_command', {
      cmd: command,
      workdir: workspacePath,
      yield_time_ms: 1000,
    })
  }
  if (tools.some(tool => tool?.name === 'shell_command')) {
    return selectTool(request, 'shell_command', {
      command,
      workdir: workspacePath,
      timeout_ms: 10_000,
    })
  }
  throw new Error('Real Codex did not advertise a supported shell tool')
}

function selectApplyPatchTool(request) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  assert.ok(
    tools.some(tool => tool?.name === 'apply_patch'),
    `Real Codex did not advertise apply_patch: ${tools
      .map(tool => tool?.name)
      .filter(Boolean)
      .join(', ')}`
  )
  return [
    '*** Begin Patch',
    `*** Add File: ${ARTIFACT_NAME}`,
    `+${ARTIFACT_CONTENT}`,
    '*** End Patch',
  ].join('\n')
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
    this.commandResults = new Map()
    this.commandHistory = []
    this.modelRequests = []
    this.blockedCloudRequests = []
    this.blockedCloudResponses = new Set()
    this.blockedCloudWaiters = []
    this.failCloudModels = false
    this.failedCloudModelRequests = 0
    this.failedCloudModelWaiter = null
    this.scenario = 'initial'
    this.modelStage = 'initial'
    this.toolLessPrewarmHandled = false
    this.toolOutput = null
    this.initialToolRelease = new Promise(resolvePromise => {
      this.releaseInitialTool = resolvePromise
    })
    this.retryCompletionRelease = new Promise(resolvePromise => {
      this.releaseRetryCompletion = resolvePromise
    })
    this.requestUserInputRelease = new Promise(resolvePromise => {
      this.releaseRequestUserInput = resolvePromise
    })
    this.requestUserInputResponseWritten = new Promise(resolvePromise => {
      this.resolveRequestUserInputResponseWritten = resolvePromise
    })
    this.scenarioRequests = new Map()
    this.scenarioWaiters = new Map()
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
    for (const response of this.blockedCloudResponses) response.destroy()
    this.blockedCloudResponses.clear()
    this.server.closeAllConnections?.()
    await new Promise(resolvePromise => this.server.close(resolvePromise))
  }

  awaitReady() {
    if (this.ready) return Promise.resolve(this.ready)
    return new Promise(resolvePromise => {
      this.readyResolver = resolvePromise
    })
  }

  awaitBlockedCloudRequest(pathname) {
    const request = this.blockedCloudRequests.find(item => item.pathname === pathname)
    if (request) return Promise.resolve(request)
    return new Promise(resolvePromise => {
      this.blockedCloudWaiters.push({ pathname, resolve: resolvePromise })
    })
  }

  blockCloudRequest(request, response, url) {
    const blockedRequest = {
      method: request.method,
      pathname: url.pathname,
      search: url.search,
    }
    this.blockedCloudRequests.push(blockedRequest)
    this.blockedCloudResponses.add(response)
    response.once('close', () => this.blockedCloudResponses.delete(response))

    const remainingWaiters = []
    for (const waiter of this.blockedCloudWaiters) {
      if (waiter.pathname === url.pathname) {
        waiter.resolve(blockedRequest)
      } else {
        remainingWaiters.push(waiter)
      }
    }
    this.blockedCloudWaiters = remainingWaiters
  }

  failBlockedCloudModels() {
    this.failCloudModels = true
    for (const response of this.blockedCloudResponses) {
      json(response, 503, { error: 'Desktop E2E intentional cloud model failure' })
    }
    this.blockedCloudResponses.clear()
  }

  awaitFailedCloudModelRequest() {
    if (this.failedCloudModelRequests > 0) return Promise.resolve()
    return new Promise(resolvePromise => {
      this.failedCloudModelWaiter = resolvePromise
    })
  }

  setScenario(scenario) {
    assert.ok(
      [
        'initial',
        'follow_up',
        'request_user_input',
        'cancellation',
        'retry',
        'fresh_chat',
      ].includes(scenario),
      `Unknown desktop E2E scenario: ${scenario}`
    )
    this.scenario = scenario
  }

  recordScenarioRequest(scenario, request) {
    const requests = this.scenarioRequests.get(scenario) ?? []
    requests.push(request)
    this.scenarioRequests.set(scenario, requests)
    const waiter = this.scenarioWaiters.get(scenario)
    if (waiter) {
      this.scenarioWaiters.delete(scenario)
      waiter(request)
    }
  }

  awaitScenarioRequest(scenario) {
    const request = this.scenarioRequests.get(scenario)?.at(-1)
    if (request) return Promise.resolve(request)
    return new Promise(resolvePromise => {
      this.scenarioWaiters.set(scenario, resolvePromise)
    })
  }

  releaseInitialToolExecution() {
    this.releaseInitialTool()
  }

  releaseRetryResponse() {
    this.releaseRetryCompletion()
  }

  releaseRequestUserInputResponse() {
    this.releaseRequestUserInput()
    return this.requestUserInputResponseWritten
  }

  async command(action, selector, options = {}) {
    const id = randomUUID()
    const command = { id, action, selector, ...options }
    const result = new Promise((resolvePromise, reject) => {
      this.commandResults.set(id, { resolve: resolvePromise, reject })
    })
    this.commandQueue.push(command)
    return withTimeout(
      result,
      options.timeoutMs ?? UI_TIMEOUT_MS,
      `Timed out running UI action ${action} for ${selector}`
    )
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
        const command = this.commandQueue.shift()
        this.commandHistory.push({ ...command, deliveredAt: new Date().toISOString() })
        json(response, 200, command)
        return
      }
      response.writeHead(204)
      response.end()
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

    if (request.method === 'GET' && url.pathname === '/api/users/me') {
      json(response, 200, {
        id: 9001,
        user_name: 'wework-desktop-e2e-cloud-user',
        email: 'desktop-e2e@wework.local',
      })
      return
    }

    if (request.method === 'GET' && url.pathname === BLOCKED_CLOUD_MODEL_PATH) {
      if (this.failCloudModels) {
        this.failedCloudModelRequests += 1
        this.failedCloudModelWaiter?.()
        this.failedCloudModelWaiter = null
        json(response, 503, { error: 'Desktop E2E intentional cloud model failure' })
        return
      }
      this.blockCloudRequest(request, response, url)
      return
    }

    if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      json(response, 200, {
        object: 'list',
        data: [
          { id: MODEL_ID, object: 'model', created: 0, owned_by: MODEL_PROVIDER_ID },
          { id: DEFAULT_MODEL_ID, object: 'model', created: 0, owned_by: MODEL_PROVIDER_ID },
        ],
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
    const modelRequest = { authorization, body, scenario: this.scenario }
    this.modelRequests.push(modelRequest)
    if (authorization !== `Bearer ${MODEL_API_KEY}`) {
      json(response, 401, { error: 'The Desktop E2E model API key was not forwarded by Codex' })
      return
    }

    const responseId = `wework-e2e-response-${this.modelRequests.length}`
    const requestKind = codexRequestKind(body)
    if (requestKind === 'compaction') {
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage('Desktop E2E context compaction completed.'),
        responseCompleted(responseId),
      ])
      return
    }

    if (requestKind === 'prewarm') {
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    // Codex CLI 0.144 can prewarm a custom Responses provider before adding
    // tool definitions or request metadata. It must not advance the task loop.
    if (
      this.scenario === 'initial' &&
      this.modelStage === 'initial' &&
      !this.toolLessPrewarmHandled &&
      !requestAdvertisesShellTool(body)
    ) {
      this.toolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (this.scenario === 'initial' && this.modelStage === 'initial') {
      this.recordScenarioRequest('initial', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(TASK_PROMPT),
        'The real Codex request did not contain the UI task prompt'
      )
      const tool = selectShellTool(body, this.workspacePath)
      const patch = selectApplyPatchTool(body)
      this.modelStage = 'awaiting_tool_output'
      await this.initialToolRelease
      this.writeSse(response, [
        responseCreated(responseId),
        functionCall('wework-e2e-tool-call', tool.name, tool.arguments),
        customToolCall('wework-e2e-apply-patch', 'apply_patch', patch),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'initial') {
      assert.equal(
        this.modelStage,
        'awaiting_tool_output',
        `Unexpected desktop E2E model stage: ${this.modelStage}`
      )
      this.recordScenarioRequest('initial', modelRequest)
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The real Codex request did not report its tool output to the model service'
      )
      this.toolOutput = JSON.stringify(body.input)
      this.modelStage = 'complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'follow_up') {
      this.recordScenarioRequest('follow_up', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(FOLLOW_UP_PROMPT),
        'The real Codex request did not contain the follow-up prompt'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(FOLLOW_UP_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'request_user_input') {
      this.recordScenarioRequest('request_user_input', modelRequest)
      if (JSON.stringify(body.input).includes('wework-e2e-request-user-input')) {
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(REQUEST_USER_INPUT_COMPLETION_TEXT),
          responseCompleted(responseId),
        ])
        return
      }
      assert.ok(
        JSON.stringify(body).includes(REQUEST_USER_INPUT_PROMPT),
        'The real Codex request did not contain the request-user-input prompt'
      )
      const tool = selectTool(body, 'request_user_input', {
        questions: [
          {
            header: 'Direction',
            id: 'direction',
            question: REQUEST_USER_INPUT_QUESTION,
            options: [
              { label: 'Minimal', description: 'Make the smallest focused change.' },
              { label: 'Complete', description: 'Cover the full interaction flow.' },
            ],
          },
        ],
      })
      await this.requestUserInputRelease
      this.writeSse(response, [
        responseCreated(responseId),
        functionCall('wework-e2e-request-user-input', tool.name, tool.arguments),
        responseCompleted(responseId),
      ])
      this.resolveRequestUserInputResponseWritten()
      return
    }

    if (this.scenario === 'fresh_chat') {
      this.recordScenarioRequest('fresh_chat', modelRequest)
      assert.ok(JSON.stringify(body).includes(FRESH_CHAT_PROMPT), 'The fresh chat prompt was lost')
      assert.equal(
        JSON.stringify(body).includes(TASK_PROMPT),
        false,
        'The new conversation inherited the previous task context'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(FRESH_CHAT_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'cancellation') {
      this.recordScenarioRequest('cancellation', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(CANCELLATION_PROMPT),
        'The real Codex request did not contain the cancellation prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      return
    }

    if (this.scenario === 'retry') {
      this.recordScenarioRequest('retry', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(RETRY_PROMPT),
        'The real Codex request did not contain the retry prompt'
      )
      const retryRequests = this.scenarioRequests.get('retry') ?? []
      if (retryRequests.length === 1) {
        this.writeSse(response, [
          responseCreated(responseId),
          responseFailed(responseId, 'WEWORK_DESKTOP_E2E_RETRY_FAILURE'),
        ])
        return
      }
      await this.retryCompletionRelease
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(RETRY_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    throw new Error(`Unexpected desktop E2E scenario: ${this.scenario}`)
  }

  writeSse(response, events) {
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
    `model_provider = "${MODEL_PROVIDER_ID}"\nmodel = "${DEFAULT_MODEL_ID}"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n[model_providers.${MODEL_PROVIDER_ID}]\nname = "Wework Desktop E2E"\nbase_url = "${modelServerUrl}/v1"\nenv_key = "WEWORK_E2E_MODEL_API_KEY"\nwire_api = "responses"\n`,
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

async function readTauriMainBinaryName() {
  const configPath = join(weworkDir, 'src-tauri', 'tauri.conf.json')
  try {
    const raw = await readFile(configPath, 'utf8')
    const config = JSON.parse(raw)
    return config.mainBinaryName || 'app'
  } catch {
    return 'app'
  }
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
        VITE_WEWORK_E2E_CLOUD_BACKEND_URL: controlUrl,
        VITE_WEWORK_E2E: 'true',
        VITE_WEWORK_RUNTIME_MODE: 'local-first',
      },
    }
  )
  const mainBinaryName = await readTauriMainBinaryName()
  const binaryName = process.platform === 'win32' ? `${mainBinaryName}.exe` : mainBinaryName
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
  await writeFile(join(workspacePath, GIT_SEED_NAME), GIT_SEED_CONTENT)
  await writeFile(join(workspacePath, 'auth.ts'), 'export const authenticated = true\n')
  await runChecked('git', ['init'], { cwd: workspacePath })
  await runChecked('git', ['config', 'user.name', 'Wework Desktop E2E'], { cwd: workspacePath })
  await runChecked('git', ['config', 'user.email', 'desktop-e2e@wework.local'], {
    cwd: workspacePath,
  })
  await runChecked('git', ['add', GIT_SEED_NAME, 'auth.ts'], { cwd: workspacePath })
  await runChecked('git', ['commit', '-m', 'test: initialize desktop e2e workspace'], {
    cwd: workspacePath,
  })

  const control = new DesktopE2EServer(workspacePath)
  let app
  let phase = 'startup'
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

    app = spawn(appBinary, [], {
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
        DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
        DEVICE_SESSION_GATEWAY_PORT: '0',
        VITE_WEWORK_E2E: 'true',
        WEWORK_E2E_MODEL_API_KEY: MODEL_API_KEY,
        WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR: '127.0.0.1:0',
        WEWORK_EXECUTOR_SIDECAR: executorBinary,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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

    phase = 'cloud-request-non-blocking'
    await withTimeout(
      control.awaitBlockedCloudRequest(BLOCKED_CLOUD_MODEL_PATH),
      WORKBENCH_READY_TIMEOUT_MS,
      'The connected desktop app did not start the intentionally blocked cloud model request'
    )
    await control.command('waitFor', '[data-testid="projects-create-button"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    control.failBlockedCloudModels()
    await triggerModelReloadUntilCloudFailure(control)

    phase = 'remote-project-dialog'
    await control.command('click', '[data-testid="projects-create-button"]')
    await control.command('click', '[data-testid="project-create-remote-option"]')
    await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    const remoteProjectDialogText = await control.command(
      'getText',
      '[data-testid="standalone-folder-project-dialog"]'
    )
    assert.match(
      remoteProjectDialogText,
      /New remote project|新建远程项目/,
      'The remote project dialog title was not localized'
    )
    await control.command('click', '[data-testid="standalone-folder-project-dialog-overlay"]')
    const closedRemoteDialogSnapshot = JSON.parse(await control.command('snapshot', 'body'))
    assert.equal(
      closedRemoteDialogSnapshot.testIds.includes('standalone-folder-project-dialog'),
      false,
      'Clicking the remote project dialog backdrop did not restore the workbench'
    )

    phase = 'project-folder-cancel'
    await control.command('click', '[data-testid="projects-create-button"]')
    await control.command('click', '[data-testid="project-create-existing-option"]')
    await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="cancel-device-folder-picker-button"]')
    const cancelledFolderPickerSnapshot = JSON.parse(await control.command('snapshot', 'body'))
    assert.equal(
      cancelledFolderPickerSnapshot.testIds.includes('standalone-folder-project-dialog'),
      false,
      'Cancelling folder selection did not restore the workbench'
    )

    phase = 'project-folder-select'
    await control.command('click', '[data-testid="projects-create-button"]')
    await control.command('click', '[data-testid="project-create-existing-option"]')
    await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('fill', '[data-testid="device-folder-path-input"]', {
      value: workspacePath,
    })
    await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
    await control.command('click', '[data-testid="confirm-device-folder-picker-button"]')

    const composerSelector = ACTIVE_COMPOSER_SELECTOR
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })

    phase = 'project-folder-remove-immediately'
    const openedProjectSnapshot = await waitForSnapshot(
      control,
      snapshot => snapshot.testIds.some(testId => testId.startsWith('project-menu-')),
      'The newly opened folder project was not shown in the sidebar'
    )
    const projectMenuTestId = openedProjectSnapshot.testIds.find(testId =>
      testId.startsWith('project-menu-')
    )
    assert.ok(projectMenuTestId, 'The newly opened folder project was not shown in the sidebar')
    const projectId = projectMenuTestId.slice('project-menu-'.length)
    await control.command('click', `[data-testid="${projectMenuTestId}"]`)
    await control.command('click', `[data-testid="remove-project-${projectId}"]`)
    await control.command(
      'click',
      `[data-testid="remove-project-dialog-${projectId}-confirm-button"]`
    )
    await waitForSnapshot(
      control,
      snapshot => !snapshot.testIds.includes(projectMenuTestId),
      'A folder project could not be removed immediately after it was opened'
    )

    phase = 'project-folder-reopen'
    await control.command('click', '[data-testid="projects-create-button"]')
    await control.command('click', '[data-testid="project-create-existing-option"]')
    await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('fill', '[data-testid="device-folder-path-input"]', {
      value: workspacePath,
    })
    await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
    await control.command('click', '[data-testid="confirm-device-folder-picker-button"]')
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid^="project-menu-"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })

    await selectE2EModel(control)
    phase = 'initial-task'
    await sendPrompt(control, composerSelector, TASK_PROMPT)
    await control.command('waitFor', '[data-testid="environment-info-button"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    const environmentSnapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (!environmentSnapshot.testIds.includes('environment-changes-button')) {
      await control.command('click', '[data-testid="environment-info-button"]')
    }
    await control.command('waitFor', '[data-testid="environment-changes-button"]', {
      text: '+0',
      timeoutMs: UI_TIMEOUT_MS,
    })
    const cleanEnvironmentText = await control.command(
      'getText',
      '[data-testid="environment-changes-button"]'
    )
    assert.match(cleanEnvironmentText, /\+0\s*-0/, 'The clean workspace diff was not displayed')

    control.releaseInitialToolExecution()
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="final-processing-toggle"]')
    await control.command('waitFor', '[data-testid="processing-summary-toggle"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    const processingSummaryText = await control.command(
      'getText',
      '[data-testid="processing-summary-toggle"]'
    )
    assert.match(
      processingSummaryText,
      /调用 1 个工具|Called 1 tools/,
      'The processing summary did not count edited files separately from tool calls'
    )
    await control.command('waitFor', '[aria-label="编辑 1"], [aria-label="Edits 1"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    const processingSummaryScreenshot = await control.command(
      'capture',
      '[data-testid="processing-summary-header"]'
    )
    await writeFile(
      join(resultDir, 'processing-summary.png'),
      Buffer.from(processingSummaryScreenshot.replace(/^data:image\/png;base64,/, ''), 'base64')
    )
    await control.command('waitFor', '[data-testid="environment-changes-button"]', {
      text: '+1',
      timeoutMs: UI_TIMEOUT_MS,
    })
    const changedEnvironmentText = await control.command(
      'getText',
      '[data-testid="environment-changes-button"]'
    )
    assert.match(
      changedEnvironmentText,
      /\+1\s*-0/,
      'The environment diff did not refresh after the real tool changed the workspace'
    )

    phase = 'workspace-mention'
    await control.command('fill', composerSelector, { value: '@' })
    await control.command('waitFor', '[data-testid="mention-files-action"]', {
      enabled: true,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('fill', composerSelector, { value: '@auth' })
    await control.command('waitFor', '[data-testid="workspace-mention-option-0"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="workspace-mention-option-0"]')
    await control.command('waitFor', '[data-testid="composer-path-chip-auth-ts"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('fill', composerSelector, { value: '' })

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

    phase = 'conversation-model-restore'
    const taskSnapshot = await waitForSnapshot(
      control,
      snapshot => snapshot.testIds.some(testId => testId.startsWith('runtime-local-task-row-')),
      'The completed task was not available for model restoration'
    )
    const taskRowTestId = taskSnapshot.testIds.find(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
    assert.ok(taskRowTestId, 'The completed task row was not found')
    if (!REQUEST_INPUT_ONLY) {
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composerSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await control.command('click', `[data-testid="${taskRowTestId}"]`)
      await control.command('waitFor', '[data-testid="model-selector-button"]', {
        text: MODEL_LABEL,
        timeoutMs: UI_TIMEOUT_MS,
      })

      phase = 'follow-up'
      control.setScenario('follow_up')
      const followUpRequest = await sendPromptUntilScenarioRequest(
        control,
        composerSelector,
        FOLLOW_UP_PROMPT,
        'follow_up'
      )
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FOLLOW_UP_COMPLETION_TEXT,
        timeoutMs: UI_TIMEOUT_MS,
      })
      assert.ok(
        JSON.stringify(followUpRequest.body).includes(FOLLOW_UP_PROMPT),
        'The follow-up request did not preserve the user prompt'
      )
    }

    phase = 'background-request-user-input'
    control.setScenario('request_user_input')
    await control.command('click', '[data-testid="add-context-button"]')
    await control.command('click', '[data-testid="set-plan-mode-button"]')
    await control.command('waitFor', '[data-testid="plan-mode-pill"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await sendPromptUntilScenarioRequest(
      control,
      composerSelector,
      REQUEST_USER_INPUT_PROMPT,
      'request_user_input'
    )
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('click', composerSelector)
    await control.command('press', 'body', { key: 'Escape' })
    await captureVerificationScreenshot(control, '01-request-running-in-background.png')
    await withTimeout(
      control.releaseRequestUserInputResponse(),
      UI_TIMEOUT_MS,
      'Timed out waiting for the request-user-input SSE response'
    )
    await control.command('press', 'body', { key: 'Escape' })
    await control.command('click', `[data-testid="${taskRowTestId}"]`)
    await control.command('waitFor', '[data-testid="request-user-input-card"]', {
      text: REQUEST_USER_INPUT_QUESTION,
      visible: true,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(control, '02-background-request-user-input-visible.png')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 3_000))
    await control.command('click', '[data-testid="request-user-input-option-direction-1"]')
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: REQUEST_USER_INPUT_COMPLETION_TEXT,
      visible: true,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: UI_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(control, '03-delayed-answer-completed.png')
    await control.command('click', '[data-testid="cancel-plan-mode-button"]')
    if (REQUEST_INPUT_ONLY) return

    phase = 'cancellation'
    control.setScenario('cancellation')
    await sendPrompt(control, composerSelector, CANCELLATION_PROMPT)
    await withTimeout(
      control.awaitScenarioRequest('cancellation'),
      UI_TIMEOUT_MS,
      'The model service did not receive the cancellation request'
    )
    await control.command('waitFor', '[data-testid="pause-response-button"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="pause-response-button"]')
    await control.command('waitFor', '[data-testid="assistant-stopped-notice"]', {
      timeoutMs: UI_TIMEOUT_MS,
    })
    const cancellationText = await control.command('getText', 'body')
    assert.equal(
      cancellationText.includes(CANCELLATION_COMPLETION_TEXT),
      false,
      'The cancelled task unexpectedly rendered a completion response'
    )

    phase = 'retry'
    control.setScenario('retry')
    await sendPromptUntilScenarioRequest(control, composerSelector, RETRY_PROMPT, 'retry')
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-card"]`,
      {
        timeoutMs: UI_TIMEOUT_MS,
      }
    )
    await control.command(
      'clickWhenEnabled',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-retry"]`,
      {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: UI_TIMEOUT_MS,
      }
    )
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`,
      {
        timeoutMs: UI_TIMEOUT_MS,
      }
    )
    control.releaseRetryResponse()
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      {
        text: RETRY_COMPLETION_TEXT,
        timeoutMs: UI_TIMEOUT_MS,
      }
    )
    assert.equal(
      control.scenarioRequests.get('retry')?.length,
      2,
      'Retry did not issue exactly one additional request for the failed user message'
    )

    phase = 'fresh-chat'
    control.setScenario('fresh_chat')
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    const freshChatSnapshot = JSON.parse(await control.command('snapshot', 'body'))
    assert.equal(
      freshChatSnapshot.text.includes(TASK_PROMPT),
      false,
      'The new conversation retained the previous task'
    )
    await sendPrompt(control, composerSelector, FRESH_CHAT_PROMPT)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: FRESH_CHAT_COMPLETION_TEXT,
      timeoutMs: UI_TIMEOUT_MS,
    })

    phase = 'standalone-new-task-state'
    await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
    const standaloneTaskSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes('project-work-button') &&
        (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
      'The task-section new-task action selected a project'
    )
    assert.ok(
      standaloneTaskSnapshot.testIds.includes('project-work-button'),
      'The standalone new task did not render the project selector'
    )

    await control.command('click', '[data-testid="new-chat-button"]')
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes('project-work-button') &&
        (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
      'The global new-task action did not preserve the standalone project state'
    )

    phase = 'permanent-worktree-create'
    const sourceProjectId = projectId
    const sourceProjectMenuTestId = `project-menu-${sourceProjectId}`
    await control.command('waitFor', `[data-testid="${sourceProjectMenuTestId}"]`, {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('click', `[data-testid="${sourceProjectMenuTestId}"]`)
    await control.command('click', `[data-testid="create-permanent-worktree-${sourceProjectId}"]`)
    await control.command('waitFor', `[data-testid="permanent-worktree-name-${sourceProjectId}"]`, {
      timeoutMs: UI_TIMEOUT_MS,
    })
    await control.command('fill', `[data-testid="permanent-worktree-name-${sourceProjectId}"]`, {
      value: 'Permanent E2E',
    })
    await control.command(
      'click',
      `[data-testid="confirm-create-permanent-worktree-${sourceProjectId}"]`
    )
    await waitForSnapshot(
      control,
      snapshot => snapshot.text.includes('Permanent E2E'),
      'The permanent worktree was not added to the project list'
    )
    const appRuntimeEntries = await readdir(join(executorHome, 'app-runtime'), {
      withFileTypes: true,
    })
    const appRuntimeDirectory = appRuntimeEntries.find(entry => entry.isDirectory())
    assert.ok(appRuntimeDirectory, 'The isolated app runtime directory was not created')
    const worktreeState = JSON.parse(
      await readFile(
        join(
          executorHome,
          'app-runtime',
          appRuntimeDirectory.name,
          'runtime-work',
          'worktrees.json'
        ),
        'utf8'
      )
    )
    assert.equal(
      Object.values(worktreeState.records ?? {}).some(record => record.permanent === true),
      true,
      'The created worktree was not marked permanent'
    )

    await writeFile(
      join(resultDir, 'model-requests.json'),
      `${JSON.stringify(control.modelRequests, null, 2)}\n`,
      'utf8'
    )
    console.log(`Wework desktop task-flow E2E passed. Diagnostics: ${resultDir}`)
  } catch (error) {
    await writeFile(
      join(resultDir, 'scenario-state.json'),
      `${JSON.stringify(
        {
          phase,
          scenario: control.scenario,
          modelStage: control.modelStage,
          scenarioRequestCounts: Object.fromEntries(
            [...control.scenarioRequests.entries()].map(([name, requests]) => [
              name,
              requests.length,
            ])
          ),
          commandHistory: control.commandHistory,
        },
        null,
        2
      )}\n`,
      'utf8'
    )
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
