import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { MOBILE_CHECKPOINTS } from './checkpoints.mjs'

const mobileDir = resolve(import.meta.dirname, '..')
const platform = process.argv[2]
const requestedFlow = readOption('--flow')
const reuseApp = process.argv.includes('--reuse-app')
const supportedPlatforms = new Set(['ios', 'android'])
const checkpointControllerTimeoutMs = 5 * 60_000
const maestroDriverStartupTimeoutMs = 3 * 60_000
const mobileRuntimeModelName = 'mobile-e2e-runtime-model'

assert.ok(
  supportedPlatforms.has(platform),
  'Usage: node e2e/run.mjs <ios|android> [--flow name] [--reuse-app]'
)
assert.ok(
  requestedFlow && MOBILE_CHECKPOINTS.includes(requestedFlow),
  `Unknown Mobile E2E checkpoint: ${requestedFlow}`
)

if (platform === 'ios' && !process.env.WEWORK_MOBILE_E2E_DEVICE?.trim()) {
  process.env.WEWORK_MOBILE_E2E_DEVICE = resolveBootedIosSimulator()
}

process.env.WEWORK_E2E_RESULT_ROOT ??= join(mobileDir, 'test-results', 'mobile-e2e')

const [{ DesktopE2EServer }, { RealCloudEnvironment }, buildFlows, shared] = await Promise.all([
  import('../../wework/e2e/desktop/modules/desktop-server.mjs'),
  import('../../wework/e2e/desktop/modules/cloud-environment.mjs'),
  import('../../wework/e2e/desktop/modules/desktop-build-flows.mjs'),
  import('../../wework/e2e/desktop/modules/shared.mjs'),
])

const { buildExecutor, resolveDesktopCodexBinary } = buildFlows
const {
  CLOUD_COMPLETION_TEXT,
  CLOUD_DEVICE_ID,
  CLOUD_FOLLOW_UP_COMPLETION_TEXT,
  CLOUD_FOLLOW_UP_PROMPT,
  CLOUD_MODEL_CASES,
  CLOUD_TASK_PROMPT,
  CANCELLATION_PROMPT,
  DEFAULT_MODEL_ID,
  GIT_SEED_CONTENT,
  GIT_SEED_NAME,
  MODEL_API_KEY,
  RECONNECT_COMPLETION_TEXT,
  RECONNECT_PROMPT,
  REMOTE_DOCKER_DEVICE_ID,
  TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX,
  TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX,
  TOOL_BLOCK_ORDER_COMPLETION_TEXT,
  TOOL_BLOCK_ORDER_PROMPT,
  commandOutput,
  fetchJson,
  resultDir,
  runChecked,
  waitForLogPattern,
} = shared

const workspacePath = join('/tmp', 'wme2e')
const control = new DesktopE2EServer(workspacePath)
const checkpointSync = createCheckpointSyncServer()
let cloudEnvironment
let approvalLoop
let controlStarted = false

try {
  await mkdir(resultDir, { recursive: true })
  await prepareWorkspace(workspacePath)
  await checkpointSync?.start()
  await control.start()
  controlStarted = true

  const codexBinary = await resolveDesktopCodexBinary()
  cloudEnvironment = new RealCloudEnvironment({
    codexBinary,
    modelServerUrl: control.url,
    workspacePath,
  })
  const [executorBinary] = await Promise.all([buildExecutor(), cloudEnvironment.startBackend()])
  await seedMobileRuntimeModel(cloudEnvironment)
  await cloudEnvironment.startRemoteExecutor(executorBinary)
  await cloudEnvironment.seedPluginAutoUpdateFixtures(1)

  if (platform === 'android') {
    await runChecked('adb', [
      'reverse',
      `tcp:${cloudEnvironment.backendPort}`,
      `tcp:${cloudEnvironment.backendPort}`,
    ])
  }

  if (!reuseApp) await buildAndInstallApplication(platform, cloudEnvironment.backendUrl)
  approvalLoop = approveAuthorizationSessions(cloudEnvironment)
  await runCheckpoint(requestedFlow, platform, cloudEnvironment.backendUrl, checkpointSync)
} finally {
  await approvalLoop?.stop()
  await cloudEnvironment?.stop()
  if (controlStarted) await control.close()
  await checkpointSync?.close()
  await rm(workspacePath, { recursive: true, force: true })
}

async function prepareWorkspace(workspace) {
  await rm(workspace, { recursive: true, force: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, GIT_SEED_NAME), GIT_SEED_CONTENT)
  await runChecked('git', ['init'], { cwd: workspace })
  await runChecked('git', ['config', 'user.name', 'Wework Mobile E2E'], { cwd: workspace })
  await runChecked('git', ['config', 'user.email', 'mobile-e2e@wework.local'], {
    cwd: workspace,
  })
  await runChecked('git', ['add', GIT_SEED_NAME], { cwd: workspace })
  await runChecked(
    'git',
    ['commit', '--allow-empty', '-m', 'test: initialize mobile e2e workspace'],
    {
      cwd: workspace,
    }
  )
}

async function seedMobileRuntimeModel(environment) {
  const responsesModel = CLOUD_MODEL_CASES.find(model => model.protocol === 'responses')
  assert.ok(responsesModel, 'Mobile E2E requires the Responses cloud model fixture')
  await fetchJson(`${environment.backendUrl}/api/v1/namespaces/default/models`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${environment.authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: {
        name: mobileRuntimeModelName,
        namespace: 'default',
        displayName: 'Mobile E2E Runtime Model',
      },
      spec: {
        modelConfig: {
          env: {
            model: 'openai',
            model_id: responsesModel.modelId,
            codex_catalog_model_id: DEFAULT_MODEL_ID,
            base_url: `${control.url}/v1`,
            api_key: MODEL_API_KEY,
          },
          ui: {
            family: 'gpt',
            modelLabel: 'Mobile E2E Runtime Model',
            controls: ['speed'],
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          },
        },
        protocol: 'openai-responses',
        apiFormat: 'responses',
        modelType: 'llm',
        isWeworkAvailable: true,
      },
    }),
  })
}

async function buildAndInstallApplication(targetPlatform, backendUrl) {
  const device = process.env.WEWORK_MOBILE_E2E_DEVICE?.trim()
  if (targetPlatform === 'ios') {
    assert.ok(device, 'iOS E2E requires a booted Simulator')
    const buildRoot = await mkdtemp(join(tmpdir(), 'wegent-mobile-ios-e2e-'))
    const appPath = join(buildRoot, 'Wegent.app')
    try {
      await runProcess(
        resolve(mobileDir, '..', '.github', 'scripts', 'build-wework-mobile-ios-app.sh'),
        [device, appPath],
        {
          cwd: mobileDir,
          env: { ...process.env, EXPO_PUBLIC_BACKEND_URL: backendUrl },
        }
      )
      await runChecked('xcrun', ['simctl', 'install', device, appPath])
    } finally {
      await rm(buildRoot, { recursive: true, force: true })
    }
    return
  }

  await runProcess(
    'pnpm',
    [
      'exec',
      'expo',
      'run:android',
      '--variant',
      'debugOptimized',
      '--no-bundler',
      ...(device ? ['--device', device] : []),
    ],
    {
      cwd: mobileDir,
      env: { ...process.env, EXPO_PUBLIC_BACKEND_URL: backendUrl },
    }
  )
}

function resolveBootedIosSimulator() {
  const devices = JSON.parse(
    commandOutput('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'])
  )
  const booted = Object.values(devices.devices)
    .flat()
    .filter(device => device.state === 'Booted' && device.isAvailable !== false)
  assert.equal(
    booted.length,
    1,
    `iOS E2E requires exactly one booted Simulator, found ${booted.length}`
  )
  return booted[0].udid
}

function approveAuthorizationSessions(environment) {
  let stopped = false
  const approved = new Set()
  const done = (async () => {
    while (!stopped) {
      const keys = commandOutput('redis-cli', [
        '-p',
        String(environment.redisPort),
        '--raw',
        '--scan',
        '--pattern',
        'wework_auth_session:*',
      ])
        .split(/\r?\n/u)
        .map(value => value.trim())
        .filter(Boolean)

      for (const key of keys) {
        const sessionId = key.slice('wework_auth_session:'.length)
        if (!sessionId || approved.has(sessionId)) continue
        const sessionJson = commandOutput('redis-cli', [
          '-p',
          String(environment.redisPort),
          '--raw',
          'GET',
          key,
        ])
        if (!sessionJson) continue
        const session = JSON.parse(sessionJson)
        if (session.status !== 'pending') continue
        assert.equal(
          session.auth_mode,
          'device_bound_refresh',
          'Mobile E2E authorization must remain device-bound'
        )
        await fetchJson(`${environment.backendUrl}/api/auth/wework/sessions/${sessionId}/approve`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${environment.authToken}` },
        })
        approved.add(sessionId)
      }
      await delay(100)
    }
  })()
  return {
    done,
    async stop() {
      stopped = true
      await done
    },
  }
}

async function runCheckpoint(flow, targetPlatform, backendUrl, sync) {
  const controller = startCheckpointController(flow, sync)
  const backendLog = await readFile(cloudEnvironment.backendLogPath, 'utf8').catch(() => '')
  const authorization = startAuthorizationController(
    sync,
    cloudEnvironment.backendLogPath,
    backendLog.length
  )
  const maestro = runMaestro(flow, targetPlatform, backendUrl, sync?.url)
  await Promise.race([
    maestro,
    approvalLoop.done,
    rejectOnFailure(authorization),
    rejectOnFailure(controller),
  ])
  await Promise.all([authorization, controller])
  verifyCheckpointSideEffects(flow, targetPlatform)
}

function startAuthorizationController(sync, backendLogPath, backendLogOffset) {
  return (async () => {
    const signal = await sync.waitFor('authorization-complete')
    await waitForLogPattern(backendLogPath, /response: GET \/api\/users\/me .* 200 /u, {
      fromOffset: backendLogOffset,
      timeoutMs: checkpointControllerTimeoutMs,
    })
    signal.acknowledge()
  })()
}

function verifyCheckpointSideEffects(flow, targetPlatform) {
  if (flow !== 'history' || targetPlatform !== 'ios') return
  const device = process.env.WEWORK_MOBILE_E2E_DEVICE?.trim()
  assert.ok(device, 'History clipboard verification requires an iOS Simulator')
  const clipboard = commandOutput('xcrun', ['simctl', 'pbpaste', device])
  assert.match(
    clipboard,
    new RegExp(TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX),
    'Copying an assistant message must write its full content to the iOS system clipboard'
  )
}

function startCheckpointController(flow, sync) {
  if (flow === 'runtime') {
    assert.ok(sync, 'Runtime E2E requires checkpoint synchronization')
    control.setScenario('cloud_initial')
    return (async () => {
      const readySignal = await sync.waitFor('runtime-ready')
      readySignal.acknowledge()
      await control.awaitScenarioRequestCount('cloud_initial', 2, checkpointControllerTimeoutMs)
      control.setScenario('cloud_follow_up')
      await control.awaitScenarioRequest('cloud_follow_up')
      control.releaseCloudFollowUpResponse()
      control.setScenario('cancellation')
      await control.awaitScenarioRequest('cancellation')
    })()
  }
  if (flow === 'history') {
    assert.ok(sync, 'History E2E requires checkpoint synchronization')
    control.setScenario('turn_navigation')
    return (async () => {
      const readySignal = await sync.waitFor('history-ready')
      readySignal.acknowledge()
      await control.awaitScenarioRequestCount('turn_navigation', 6, checkpointControllerTimeoutMs)
    })()
  }
  if (flow === 'recovery') {
    assert.ok(sync, 'Recovery E2E requires checkpoint synchronization')
    control.setScenario('reconnect')
    return (async () => {
      const [, streamingSignal] = await Promise.all([
        control.awaitReconnectResponseStarted(),
        sync.waitFor('reconnect-streaming'),
      ])
      control.disconnectReconnectResponse()
      streamingSignal.acknowledge()
      await control.awaitScenarioRequestCount('reconnect', 2, checkpointControllerTimeoutMs)
      control.releaseReconnectResponse()
    })()
  }
  control.setScenario('initial')
  return Promise.resolve()
}

function rejectOnFailure(promise) {
  return promise.then(() => new Promise(() => {}))
}

async function runMaestro(flow, targetPlatform, backendUrl, syncUrl) {
  const maestro = process.env.MAESTRO_BIN?.trim() || 'maestro'
  const device = process.env.WEWORK_MOBILE_E2E_DEVICE?.trim()
  const flowPath = join(mobileDir, '.maestro', `${flow}.yaml`)
  const args = [
    ...(device ? ['--device', device] : []),
    'test',
    '--format',
    'junit',
    '--output',
    join(resultDir, `maestro-${targetPlatform}-${flow}.xml`),
    '--env',
    `E2E_BACKEND_URL=${backendUrl}`,
    '--env',
    `E2E_DEVICE_ID=${CLOUD_DEVICE_ID}`,
    '--env',
    `E2E_SECOND_DEVICE_ID=${REMOTE_DOCKER_DEVICE_ID}`,
    '--env',
    `E2E_WORKSPACE_PATH=${workspacePath}`,
    ...(syncUrl ? ['--env', `E2E_SYNC_URL=${syncUrl}`] : []),
    ...(syncUrl ? ['--env', `E2E_CHECKPOINT_READY_SIGNAL=${flow}-ready`] : []),
    '--env',
    'E2E_PROJECT_NAME=e2e',
    '--env',
    `E2E_MODEL_ID=${mobileRuntimeModelName}`,
    '--env',
    `E2E_CLOUD_PROMPT=${CLOUD_TASK_PROMPT}`,
    '--env',
    `E2E_CLOUD_COMPLETION=${CLOUD_COMPLETION_TEXT}`,
    '--env',
    `E2E_FOLLOW_UP_PROMPT=${CLOUD_FOLLOW_UP_PROMPT}`,
    '--env',
    `E2E_FOLLOW_UP_COMPLETION=${CLOUD_FOLLOW_UP_COMPLETION_TEXT}`,
    '--env',
    `E2E_CANCEL_PROMPT=${CANCELLATION_PROMPT}`,
    '--env',
    `E2E_TOOL_PROMPT=${TOOL_BLOCK_ORDER_PROMPT}`,
    '--env',
    `E2E_TOOL_COMPLETION=${TOOL_BLOCK_ORDER_COMPLETION_TEXT}`,
    '--env',
    `E2E_RECONNECT_PROMPT=${RECONNECT_PROMPT}`,
    '--env',
    `E2E_RECONNECT_COMPLETION=${RECONNECT_COMPLETION_TEXT}`,
    '--env',
    `E2E_HISTORY_PROMPT_PREFIX=${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}`,
    '--env',
    `E2E_HISTORY_COMPLETION_PREFIX=${TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX}`,
    flowPath,
  ]
  await runProcess(maestro, args, {
    cwd: mobileDir,
    env: {
      ...process.env,
      MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
      MAESTRO_CLI_NO_ANALYTICS: 'true',
      MAESTRO_DISABLE_UPDATE_CHECK: 'true',
      MAESTRO_DRIVER_STARTUP_TIMEOUT: String(maestroDriverStartupTimeoutMs),
    },
  })
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

function readOption(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  const value = process.argv[index + 1]
  assert.ok(value && !value.startsWith('--'), `${name} requires a value`)
  return value
}

function delay(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function createCheckpointSyncServer() {
  return new (class CheckpointSyncServer {
    constructor() {
      this.server = createServer((request, response) => this.handle(request, response))
      this.pendingSignals = new Map()
      this.waiters = new Map()
      this.url = null
    }

    async start() {
      await new Promise((resolvePromise, reject) => {
        this.server.once('error', reject)
        this.server.listen(0, '127.0.0.1', resolvePromise)
      })
      const address = this.server.address()
      assert.ok(address && typeof address !== 'string', 'Checkpoint sync server has no TCP address')
      this.url = `http://127.0.0.1:${address.port}`
    }

    waitFor(name) {
      const pending = this.pendingSignals.get(name)
      if (pending) {
        this.pendingSignals.delete(name)
        return Promise.resolve(pending)
      }
      return new Promise(resolvePromise => {
        assert.ok(!this.waiters.has(name), `Checkpoint sync already waits for ${name}`)
        this.waiters.set(name, resolvePromise)
      })
    }

    handle(request, response) {
      const match = request.method === 'POST' && request.url?.match(/^\/signals\/([a-z-]+)$/u)
      if (!match) {
        response.writeHead(404).end()
        return
      }
      const name = match[1]
      const signal = {
        acknowledge: () => response.writeHead(204).end(),
      }
      const waiter = this.waiters.get(name)
      if (waiter) {
        this.waiters.delete(name)
        waiter(signal)
        return
      }
      assert.ok(!this.pendingSignals.has(name), `Checkpoint sync received duplicate ${name}`)
      this.pendingSignals.set(name, signal)
    }

    async close() {
      for (const signal of this.pendingSignals.values()) signal.acknowledge()
      this.pendingSignals.clear()
      this.server.closeAllConnections()
      if (!this.server.listening) return
      await new Promise(resolvePromise => this.server.close(resolvePromise))
    }
  })()
}
