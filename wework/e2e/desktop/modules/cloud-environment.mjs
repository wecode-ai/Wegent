import { codexUpstreamApiFormat, writeCodexConfig } from './desktop-build-flows.mjs'
import { remoteDeviceE2EExtension } from '../remote-device-extension.mjs'

import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'

import {
  CLOUD_DEVICE_ID,
  REMOTE_DOCKER_DEVICE_ID,
  CLOUD_MODEL_CASES,
  CLOUD_MULTIMODAL_VISION_CASE,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_VISION_SIDECAR_CASE,
  DEFAULT_STEP_TIMEOUT_MS,
  MODEL_API_KEY,
  PLUGIN_CREATOR_PROMPT,
  WORKBENCH_READY_TIMEOUT_MS,
  appendFile,
  appendProcessOutput,
  assert,
  commandOutput,
  commandOutputAsync,
  createServer,
  dirname,
  fetchJson,
  join,
  mkdir,
  pathExists,
  readFile,
  repoDir,
  reservePort,
  resultDir,
  runChecked,
  spawn,
  stopProcess,
  stopProcessGroup,
  waitForUrl,
  weworkDir,
  writeFile,
} from './shared.mjs'

const REDIS_START_ATTEMPTS = 5
const REDIS_READY_PATTERN = /Ready to accept connections/
const REDIS_PORT_CONFLICT_PATTERN = /Address already in use|Failed listening on port/
const MANAGED_CLOUD_SANDBOX_ID = 'wework-e2e-managed-cloud-sandbox'
const CLOUD_PUBLIC_MODEL_OPTIONS = {
  weworkCloudModelNamespace: 'default',
  weworkCloudModelResourceUserId: '0',
  weworkCloudModelUpstreamApiFormat: 'openai-responses',
}

async function waitForRedisReady(redis, logPath, fromOffset) {
  let spawnError = null
  const captureSpawnError = error => {
    spawnError = error
  }
  redis.once('error', captureSpawnError)
  const startedAt = Date.now()
  try {
    while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
      const content = await readFile(logPath, 'utf8').catch(() => '')
      const attemptOutput = content.slice(fromOffset)
      if (REDIS_READY_PATTERN.test(attemptOutput)) return attemptOutput
      if (spawnError) throw spawnError
      if (redis.exitCode !== null || redis.signalCode !== null) {
        throw new Error(
          `Redis exited before becoming ready: ${attemptOutput.trim() || 'no process output'}`
        )
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
  } finally {
    redis.off('error', captureSpawnError)
  }
  throw new Error(`Timed out waiting for Redis readiness in ${logPath}`)
}

async function startRedisServer(
  logPath,
  { reserveRedisPort = reservePort, spawnRedis = spawn } = {}
) {
  const redisServerBinary = process.env.WEWORK_E2E_REDIS_SERVER_BIN?.trim() || 'redis-server'
  for (let attempt = 1; attempt <= REDIS_START_ATTEMPTS; attempt += 1) {
    const port = await reserveRedisPort()
    const existingLog = await readFile(logPath, 'utf8').catch(() => '')
    const fromOffset = existingLog.length
    await appendFile(logPath, `Redis start attempt ${attempt} on port ${port}\n`)
    const redis = spawnRedis(
      redisServerBinary,
      ['--port', String(port), '--save', '', '--appendonly', 'no'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    await Promise.all([
      appendProcessOutput(redis.stdout, logPath),
      appendProcessOutput(redis.stderr, logPath),
    ])
    try {
      await waitForRedisReady(redis, logPath, fromOffset)
      return { port, redis }
    } catch (error) {
      await stopProcess(redis)
      const attemptOutput = (await readFile(logPath, 'utf8').catch(() => '')).slice(fromOffset)
      if (attempt < REDIS_START_ATTEMPTS && REDIS_PORT_CONFLICT_PATTERN.test(attemptOutput)) {
        continue
      }
      throw error
    }
  }
  throw new Error(`Redis did not start after ${REDIS_START_ATTEMPTS} attempts`)
}

class LocalPluginObjectStorage {
  constructor() {
    this.buckets = new Set()
    this.objects = new Map()
  }

  async start() {
    this.port = await reservePort()
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(error => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined)
          return
        }
        response.writeHead(error instanceof URIError ? 400 : 500)
        response.end()
      })
    })
    await new Promise((resolvePromise, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', resolvePromise)
    })
    this.endpoint = `http://127.0.0.1:${this.port}`
  }

  async handle(request, response) {
    const url = new URL(request.url ?? '/', this.endpoint)
    const [bucket = '', ...objectParts] = url.pathname.split('/').filter(Boolean)
    const objectKey = decodeURIComponent(objectParts.join('/'))
    const storageKey = `${bucket}/${objectKey}`
    if (!objectKey) {
      if (request.method === 'HEAD') {
        response.writeHead(
          this.buckets.has(bucket) ? 200 : 404,
          this.buckets.has(bucket)
            ? {}
            : {
                'x-minio-error-code': 'NoSuchBucket',
                'x-minio-error-desc': 'Bucket does not exist',
              }
        )
        response.end()
        return
      }
      if (request.method === 'PUT') {
        this.buckets.add(bucket)
        response.writeHead(200)
        response.end()
        return
      }
    }
    if (request.method === 'PUT') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      this.buckets.add(bucket)
      this.objects.set(storageKey, Buffer.concat(chunks))
      response.writeHead(200, {
        ETag: `"${createHash('md5').update(this.objects.get(storageKey)).digest('hex')}"`,
      })
      response.end()
      return
    }
    const object = this.objects.get(storageKey)
    if (!object) {
      response.writeHead(404, {
        'Content-Type': 'application/xml',
        'x-minio-error-code': 'NoSuchKey',
        'x-minio-error-desc': 'Object does not exist',
      })
      response.end('<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>')
      return
    }
    if (request.method === 'HEAD') {
      response.writeHead(200, {
        'Content-Length': String(object.length),
        'Last-Modified': new Date().toUTCString(),
        ETag: '"e2e"',
      })
      response.end()
      return
    }
    if (request.method === 'GET') {
      response.writeHead(200, {
        'Content-Length': String(object.length),
        'Content-Type': 'application/zip',
      })
      response.end(object)
      return
    }
    if (request.method === 'DELETE') {
      this.objects.delete(storageKey)
      response.writeHead(204)
      response.end()
      return
    }
    response.writeHead(405)
    response.end()
  }

  async stop() {
    if (!this.server) return
    await new Promise(resolvePromise => {
      this.server.close(resolvePromise)
      this.server.closeAllConnections?.()
    })
  }
}

class RealCloudEnvironment {
  constructor({
    claudeBinary,
    codexBinary,
    managedCloudIdentity = false,
    modelServerUrl,
    scenarioConfigToml = '',
    workspacePath,
  }) {
    this.claudeBinary = claudeBinary
    this.codexBinary = codexBinary
    this.managedCloudIdentity = managedCloudIdentity
    this.modelServerUrl = modelServerUrl
    this.scenarioConfigToml = scenarioConfigToml
    this.workspacePath = workspacePath
    this.generatedRemoteExecutors = []
    this.pluginAutoUpdateFixtures = []
  }

  async startBackend() {
    const backendDirectory = join(repoDir, 'backend')
    this.databasePath = join(resultDir, 'cloud-backend.sqlite3')
    this.backendLogPath = join(resultDir, 'cloud-backend.log')
    this.redisLogPath = join(resultDir, 'cloud-redis.log')
    this.remoteExecutorLogPath = join(resultDir, 'cloud-executor.log')
    this.remoteDockerExecutorLogPath = join(resultDir, 'remote-docker-executor.log')
    this.remoteExecutorRuntimeLogPath = join(resultDir, 'cloud-executor-runtime.log')
    this.remoteDockerExecutorRuntimeLogPath = join(resultDir, 'remote-docker-executor-runtime.log')
    this.pluginObjectStorage = new LocalPluginObjectStorage()
    await this.pluginObjectStorage.start()

    const redisServer = await startRedisServer(this.redisLogPath)
    this.redisPort = redisServer.port
    this.redis = redisServer.redis

    this.backendPort = await reservePort()
    this.backendUrl = `http://127.0.0.1:${this.backendPort}`
    this.socketUrl = `http://localhost:${this.backendPort}`

    const backendEnv = {
      ...process.env,
      DATABASE_URL: `sqlite:///${this.databasePath}`,
      REDIS_URL: `redis://127.0.0.1:${this.redisPort}/0`,
      SECRET_KEY: `wework-desktop-e2e-${process.pid}`,
      INTERNAL_SERVICE_TOKEN: `wework-desktop-e2e-internal-${process.pid}`,
      BACKEND_INTERNAL_URL: this.backendUrl,
      WEGENT_BACKEND_PUBLIC_URL: this.backendUrl,
      GIT_TOKEN_AES_KEY: '12345678901234567890123456789012',
      GIT_TOKEN_AES_IV: '1234567890123456',
      FRONTEND_URL: this.modelServerUrl,
      CHAT_SHELL_URL: this.modelServerUrl,
      CHAT_SHELL_MODE: 'package',
      CHAT_SHELL_TOKEN: MODEL_API_KEY,
      WEGENT_SOCKET_URL: this.socketUrl,
      ...remoteDeviceE2EExtension.backendEnv,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      DB_AUTO_MIGRATE: 'false',
      INIT_DATA_ENABLED: 'true',
      INIT_DATA_DIR: join(backendDirectory, 'init_data'),
      BUILTIN_PLUGINS_DIR: join(backendDirectory, 'init_data', 'plugins'),
      ATTACHMENT_S3_ENDPOINT: this.pluginObjectStorage.endpoint,
      ATTACHMENT_S3_ACCESS_KEY: 'desktop-e2e-access-key',
      ATTACHMENT_S3_SECRET_KEY: 'desktop-e2e-secret-key',
      ATTACHMENT_S3_USE_SSL: 'false',
    }
    this.backendEnv = backendEnv
    await runChecked('uv', ['run', 'alembic', 'upgrade', 'head'], {
      cwd: backendDirectory,
      env: backendEnv,
    })
    this.backend = spawn(
      'uv',
      [
        'run',
        'python',
        '-u',
        '-m',
        'uvicorn',
        'app.main:app',
        '--host',
        '127.0.0.1',
        '--port',
        String(this.backendPort),
      ],
      {
        cwd: backendDirectory,
        env: backendEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    await Promise.all([
      appendProcessOutput(this.backend.stdout, this.backendLogPath),
      appendProcessOutput(this.backend.stderr, this.backendLogPath),
    ])
    await waitForUrl(
      `${this.backendUrl}/api/docs`,
      `Real cloud backend did not start; see ${this.backendLogPath}`
    )

    const password = `wework-desktop-e2e-${process.pid}`
    const setup = await fetchJson(`${this.backendUrl}/api/auth/admin-password/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    this.authToken = setup.access_token
    assert.ok(this.authToken, 'Real cloud backend did not return an authentication token')
    await this.seedCloudProtocolModels()
    await this.seedCloudVisionSidecarModels()
  }

  async publishOfficialSmartApp(sourcePath) {
    assert.ok(this.backendEnv, 'Cloud backend environment is not initialized')
    await runChecked('uv', ['run', 'python', 'scripts/publish_official_smart_app.py', sourcePath], {
      cwd: join(repoDir, 'backend'),
      env: this.backendEnv,
    })
  }

  async seedPluginAutoUpdateFixtures(count = 6) {
    if (this.pluginAutoUpdateFixturesSeeded) return
    const headers = {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
    }
    for (let index = 1; index <= count; index += 1) {
      const slug = `desktop-e2e-auto-update-${index}`
      const first = await this.publishPluginRelease({ slug, version: '1.0.0' })
      await fetchJson(
        `${this.backendUrl}/api/plugins/marketplace/${first.pluginId}/install?device_id=${CLOUD_DEVICE_ID}`,
        { method: 'POST', headers }
      )
      await this.publishPluginRelease({ slug, version: '2.0.0' })
      this.pluginAutoUpdateFixtures.push({ pluginId: first.pluginId, slug })
    }
    this.pluginAutoUpdateFixturesSeeded = true
  }

  async syncPluginAutoUpdatesToCloudDevice() {
    const headers = { Authorization: `Bearer ${this.authToken}` }
    for (const fixture of this.pluginAutoUpdateFixtures) {
      await fetchJson(
        `${this.backendUrl}/api/plugins/marketplace/${fixture.pluginId}/install?device_id=${CLOUD_DEVICE_ID}`,
        { method: 'POST', headers }
      )
    }
  }

  async publishPluginRelease({ slug, version }) {
    const packageRoot = join(resultDir, 'plugin-auto-update-fixtures', `${slug}-${version}`)
    const manifestDir = join(packageRoot, '.codex-plugin')
    await mkdir(manifestDir, { recursive: true })
    await writeFile(
      join(manifestDir, 'plugin.json'),
      `${JSON.stringify({ name: slug, version, description: `Desktop E2E ${slug}` }, null, 2)}\n`,
      'utf8'
    )
    const output = await commandOutputAsync(
      'uv',
      [
        'run',
        'python',
        'scripts/publish_official_plugin.py',
        packageRoot,
        '--slug',
        slug,
        '--visibility',
        'workspace',
        '--created-by-user-id',
        '1',
        '--publisher',
        'desktop-e2e',
      ],
      { cwd: join(repoDir, 'backend'), env: this.backendEnv }
    )
    const published = JSON.parse(output)
    assert.ok(published.pluginId, 'Plugin E2E publisher did not return a plugin ID')
    assert.ok(published.releaseId, 'Plugin E2E publisher did not return a release ID')
    return published
  }

  async assertPluginAutoUpdateComplete(codexHome, expectedCount = 6) {
    const installed = await fetchJson(`${this.backendUrl}/api/plugins/installed`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    })
    const fixtures = installed.items.filter(item =>
      item.spec?.source?.pluginKey?.startsWith('desktop-e2e-auto-update-')
    )
    assert.equal(fixtures.length, expectedCount, 'Auto-update fixture install count changed')
    assert.ok(
      fixtures.every(item => item.spec.version === '2.0.0'),
      'Not every desktop E2E plugin advanced to version 2.0.0'
    )
    for (let index = 1; index <= expectedCount; index += 1) {
      const slug = `desktop-e2e-auto-update-${index}`
      const currentManifest = join(
        codexHome,
        'plugins',
        'cache',
        'wegent',
        slug,
        '2.0.0',
        '.codex-plugin',
        'plugin.json'
      )
      assert.equal(
        await pathExists(currentManifest),
        true,
        `Plugin ${slug} did not commit its updated package to the local runtime`
      )
      assert.equal(
        JSON.parse(await readFile(currentManifest, 'utf8')).version,
        '2.0.0',
        `Plugin ${slug} kept stale local runtime metadata after update`
      )
      assert.equal(
        await pathExists(join(codexHome, 'plugins', 'cache', 'wegent', slug, '1.0.0')),
        false,
        `Plugin ${slug} kept its old local runtime after update`
      )
    }
  }

  async restartCloudExecutorWithoutCodexPluginRpc() {
    assert.ok(this.remoteExecutorEnv, 'The cloud Executor environment is not initialized')
    const unavailableCodexBinary = join(resultDir, 'unavailable-codex-for-plugin-sync')
    await rm(unavailableCodexBinary, { force: true })
    this.remoteExecutorEnv.CODEX_BIN = unavailableCodexBinary
    await this.restartCloudExecutor()
  }

  executorEnv({
    deviceId,
    deviceName,
    deviceType,
    home,
    codexHome,
    logFile,
    authToken = this.authToken,
  }) {
    const environment = {
      ...process.env,
      ...(this.claudeBinary ? { CLAUDE_BINARY_PATH: this.claudeBinary } : {}),
      CODEX_BIN: this.codexBinary,
      CODEX_HOME: codexHome,
      HOME: home,
      WEGENT_CODEX_HOME: codexHome,
      WEGENT_EXECUTOR_HOME: home,
      WEGENT_EXECUTOR_LOG_DIR: resultDir,
      WEGENT_EXECUTOR_LOG_FILE: logFile,
      WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED: 'true',
      EXECUTOR_MODE: 'local',
      WEGENT_BACKEND_URL: this.backendUrl,
      WEGENT_SOCKET_URL: this.socketUrl,
      WEGENT_AUTH_TOKEN: authToken,
      DEVICE_ID: deviceId,
      DEVICE_NAME: deviceName,
      DEVICE_TYPE: deviceType,
      BIND_SHELL: 'claudecode',
      LOCAL_WORKSPACE_ROOT: dirname(this.workspacePath),
      WEGENT_WORKSPACE_ROOTS: this.workspacePath,
      WEWORK_E2E_MODEL_API_KEY: MODEL_API_KEY,
      DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
      DEVICE_SESSION_GATEWAY_PORT: '0',
    }
    for (const key of [
      'WEGENT_APP_IPC_DEVICE_ID',
      'WEGENT_APP_IPC_ENDPOINT',
      'WEGENT_APP_IPC_OWNER_TOKEN',
      'WEGENT_APP_IPC_TOKEN',
      'WEGENT_APP_LIFECYCLE_FD',
    ]) {
      delete environment[key]
    }
    return environment
  }

  async startRemoteExecutor(executorBinary) {
    this.executorBinary = executorBinary
    const remoteHome = join(resultDir, 'cloud-executor-home')
    const remoteDockerHome = join(resultDir, 'remote-docker-executor-home')
    this.remoteCodexHome = join(remoteHome, 'codex')
    this.remoteDockerCodexHome = join(remoteDockerHome, 'codex')
    await writeCodexConfig(this.remoteCodexHome, this.modelServerUrl, this.scenarioConfigToml)
    await writeCodexConfig(this.remoteDockerCodexHome, this.modelServerUrl)
    this.remoteExecutorEnv = this.executorEnv({
      deviceId: CLOUD_DEVICE_ID,
      deviceName: 'Wework E2E Cloud Device',
      deviceType: 'cloud',
      home: remoteHome,
      codexHome: this.remoteCodexHome,
      logFile: 'cloud-executor-runtime.log',
    })
    this.remoteDockerExecutorEnv = this.executorEnv({
      deviceId: REMOTE_DOCKER_DEVICE_ID,
      deviceName: 'Wework E2E Remote Docker Device',
      deviceType: 'remote',
      home: remoteDockerHome,
      codexHome: this.remoteDockerCodexHome,
      logFile: 'remote-docker-executor-runtime.log',
    })
    this.remoteExecutor = await this.spawnExecutor(
      this.remoteExecutorEnv,
      this.remoteExecutorLogPath
    )
    this.remoteDockerExecutor = await this.spawnExecutor(
      this.remoteDockerExecutorEnv,
      this.remoteDockerExecutorLogPath
    )
    await Promise.all([
      this.waitForDevice(CLOUD_DEVICE_ID, this.remoteExecutorLogPath),
      this.waitForDevice(REMOTE_DOCKER_DEVICE_ID, this.remoteDockerExecutorLogPath),
    ])
    if (this.managedCloudIdentity) {
      await this.configureManagedCloudIdentity()
    }
  }

  async configureManagedCloudIdentity() {
    await runChecked('sqlite3', [
      this.databasePath,
      [
        'UPDATE kinds',
        `SET json = json_set(json, '$.spec.cloudConfig.sandboxId', '${MANAGED_CLOUD_SANDBOX_ID}', '$.spec.cloudConfig.deviceId', '${CLOUD_DEVICE_ID}')`,
        `WHERE kind = 'Device' AND name = '${CLOUD_DEVICE_ID}';`,
      ].join(' '),
    ])

    const configured = await this.device(CLOUD_DEVICE_ID)
    assert.equal(
      configured?.cloud_config?.sandboxId,
      MANAGED_CLOUD_SANDBOX_ID,
      'The cloud E2E fixture did not create a distinct managed Sandbox identity'
    )
    assert.equal(
      configured?.cloud_config?.deviceId,
      CLOUD_DEVICE_ID,
      'The cloud E2E fixture changed the Executor route identity'
    )
    await this.restartCloudExecutor()
  }

  async describePluginWorkspace(pluginRoot, taskWorkspace, taskId) {
    assert.ok(this.executorBinary, 'Cloud Executor binary is not ready')
    assert.ok(this.remoteExecutorEnv, 'Cloud Executor environment is not initialized')
    const output = commandOutput(
      this.executorBinary,
      ['plugin-workspace', 'describe', '--plugin-root', pluginRoot, '--listing-type', 'plugin'],
      {
        cwd: pluginRoot,
        env: {
          ...this.remoteExecutorEnv,
          AUTH_TOKEN: this.authToken,
          WEGENT_TASK_ID: String(taskId),
          WEGENT_TASK_WORKSPACE: taskWorkspace,
        },
      }
    )
    const marker = output.split(/\r?\n/).find(line => line.startsWith('[WEGENT_PLUGIN_RESULT]'))
    assert.ok(marker, 'Cloud Plugin Creator did not emit a Task workspace result')
    return JSON.parse(marker.slice('[WEGENT_PLUGIN_RESULT]'.length))
  }

  async publishPluginWorkspace(pluginRoot, taskWorkspace, taskId, request) {
    assert.ok(this.executorBinary, 'Cloud Executor binary is not ready')
    assert.ok(this.remoteExecutorEnv, 'Cloud Executor environment is not initialized')
    const output = commandOutput(
      this.executorBinary,
      [
        'plugin-workspace',
        'publish',
        '--plugin-root',
        pluginRoot,
        '--listing-type',
        'plugin',
        '--request-base64',
        Buffer.from(JSON.stringify(request), 'utf8').toString('base64'),
      ],
      {
        cwd: pluginRoot,
        env: {
          ...this.remoteExecutorEnv,
          AUTH_TOKEN: this.authToken,
          WEGENT_TASK_ID: String(taskId),
          WEGENT_TASK_WORKSPACE: taskWorkspace,
        },
      }
    )
    const marker = output.split(/\r?\n/).find(line => line.startsWith('[WEGENT_PLUGIN_RESULT]'))
    assert.ok(marker, 'Cloud Plugin Creator publication did not emit a result')
    return JSON.parse(marker.slice('[WEGENT_PLUGIN_RESULT]'.length))
  }

  async createPluginWorkspaceTask() {
    const teams = await fetchJson(`${this.backendUrl}/api/teams?page=1&limit=100`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    })
    const team = teams.items?.[0]
    assert.ok(team?.id, 'Cloud Plugin Creator E2E requires a Team fixture')
    assert.ok(this.remoteCodexHome, 'Cloud Executor Codex home is not initialized')
    const workspacePath = join(
      dirname(this.remoteCodexHome),
      'Documents',
      'Codex',
      'plugin-workspace-publication',
      `${process.pid}-${Date.now()}`
    )
    await mkdir(workspacePath, { recursive: true })
    const task = await fetchJson(`${this.backendUrl}/api/runtime-work/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deviceId: CLOUD_DEVICE_ID,
        workspacePath,
        teamId: team.id,
        runtime: 'codex',
        message: PLUGIN_CREATOR_PROMPT,
        title: 'Cloud Plugin Creator E2E',
        modelId: CLOUD_PUBLIC_MODEL_NAME,
        modelType: 'public',
        modelOptions: CLOUD_PUBLIC_MODEL_OPTIONS,
        modelSelection: {
          modelName: CLOUD_PUBLIC_MODEL_NAME,
          modelType: 'public',
          options: CLOUD_PUBLIC_MODEL_OPTIONS,
        },
      }),
    })
    assert.equal(task.accepted, true, `Cloud Plugin Creator task was rejected: ${task.error}`)
    assert.ok(task.taskId, 'Cloud Plugin Creator task did not return a runtime task ID')
    assert.equal(task.workspacePath, workspacePath)
    const address = {
      deviceId: task.deviceId,
      taskId: task.taskId,
      workspacePath: task.workspacePath,
    }
    await this.waitForRuntimeTask(address)
    return address
  }

  async waitForRuntimeTask(address) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
      const task = await this.runtimeTask(address.taskId)
      if (
        task?.workspacePath === address.workspacePath &&
        ['failed', 'cancelled'].includes(task.status)
      ) {
        throw new Error(`Cloud runtime task ${address.taskId} settled as ${task.status}`)
      }
      const active =
        task?.running === true || ['creating', 'queued', 'active', 'running'].includes(task?.status)
      if (task?.workspacePath === address.workspacePath && !active) return task
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    const device = await this.device(CLOUD_DEVICE_ID).catch(() => null)
    throw new Error(
      `Cloud runtime task ${address.taskId} did not expose its workspace ` +
        `(device_status=${device?.status ?? 'unknown'})`
    )
  }

  async sendPluginWorkspaceResult(address, marker) {
    const result = await fetchJson(`${this.backendUrl}/api/runtime-work/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address,
        message: marker,
        modelSelection: {
          modelName: CLOUD_PUBLIC_MODEL_NAME,
          modelType: 'public',
          options: CLOUD_PUBLIC_MODEL_OPTIONS,
        },
      }),
    })
    assert.equal(result.accepted, true, `Cloud Plugin Creator result was rejected: ${result.error}`)
  }

  async spawnExecutor(env, logPath) {
    const executor = spawn(this.executorBinary, [], {
      cwd: weworkDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    await Promise.all([
      appendProcessOutput(executor.stdout, logPath),
      appendProcessOutput(executor.stderr, logPath),
    ])
    return executor
  }

  async device(deviceId) {
    const devices = await this.devices()
    return devices.find(device => device.device_id === deviceId) ?? null
  }

  async devices() {
    const devices = await fetchJson(`${this.backendUrl}/api/devices`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    })
    return devices.items ?? []
  }

  async waitForConnectedAppDevice() {
    const startedAt = Date.now()
    while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
      const devices = await this.devices()
      const device = devices.find(
        candidate => candidate.device_type === 'app' && candidate.status === 'online'
      )
      if (device) return device
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    throw new Error('The desktop local executor did not register as an app device')
  }

  async waitForDeviceType(deviceId, expectedType) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
      const devices = await this.devices()
      const matching = devices.filter(device => device.device_id === deviceId)
      if (
        matching.length === 1 &&
        matching[0].device_type === expectedType &&
        matching[0].status === 'online'
      ) {
        return matching[0]
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    throw new Error(`Device ${deviceId} did not become an online ${expectedType} device`)
  }

  async worktreeCapabilities(deviceId = CLOUD_DEVICE_ID) {
    return fetchJson(`${this.backendUrl}/api/runtime-work/worktrees/capabilities`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deviceId }),
    })
  }

  async worktreePreflight(sourcePath, ref = null, deviceId = CLOUD_DEVICE_ID) {
    return fetchJson(`${this.backendUrl}/api/runtime-work/worktrees/preflight`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deviceId,
        sourcePath,
        ...(ref ? { ref } : {}),
      }),
    })
  }

  async runtimeWork() {
    return fetchJson(`${this.backendUrl}/api/runtime-work`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    })
  }

  async runtimeTask(taskId) {
    const work = await this.runtimeWork()
    const workspaces = [
      ...(work.projects ?? []).flatMap(project => project.deviceWorkspaces ?? []),
      ...(work.chats ?? []),
    ]
    return workspaces
      .flatMap(workspace => workspace.tasks ?? [])
      .find(task => task.taskId === taskId)
  }

  async updateRuntimeSettings(maxConcurrentTasks, deviceId = CLOUD_DEVICE_ID) {
    return fetchJson(
      `${this.backendUrl}/api/devices/${encodeURIComponent(deviceId)}/runtime-settings`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ max_concurrent_tasks: maxConcurrentTasks }),
      }
    )
  }

  async runtimeSettings(deviceId = CLOUD_DEVICE_ID) {
    return fetchJson(
      `${this.backendUrl}/api/devices/${encodeURIComponent(deviceId)}/runtime-settings`,
      {
        headers: { Authorization: `Bearer ${this.authToken}` },
      }
    )
  }

  terminalSessionRecords() {
    const keys = commandOutput('redis-cli', [
      '-p',
      String(this.redisPort),
      '--raw',
      '--scan',
      '--pattern',
      'terminal_session:*',
    ])
      .split(/\r?\n/u)
      .map(value => value.trim())
      .filter(Boolean)
    return keys.map(key => {
      const serialized = commandOutput('redis-cli', [
        '-p',
        String(this.redisPort),
        '--raw',
        'GET',
        key,
      ])
      return JSON.parse(serialized)
    })
  }

  async restartCloudExecutor() {
    assert.ok(this.remoteExecutorEnv, 'The cloud Executor environment is not initialized')
    const previousDevice = await this.device(CLOUD_DEVICE_ID)
    const previousInstanceId = previousDevice?.runtime_instance_id
    const previousLog = await readFile(this.remoteExecutorLogPath, 'utf8').catch(() => '')
    await stopProcessGroup(this.remoteExecutor)
    await this.waitForDeviceStatus(CLOUD_DEVICE_ID, 'offline', this.remoteExecutorLogPath)
    this.remoteExecutor = await this.spawnExecutor(
      this.remoteExecutorEnv,
      this.remoteExecutorLogPath
    )
    const device = await this.waitForDeviceStatus(
      CLOUD_DEVICE_ID,
      'online',
      this.remoteExecutorLogPath
    )
    assert.equal(
      device.runtime_instance_id,
      previousInstanceId,
      'Restarting the same cloud Executor home changed its stable runtime identity'
    )
    return {
      previousInstanceId,
      runtimeInstanceId: device.runtime_instance_id,
      logOffset: previousLog.length,
    }
  }

  async startGeneratedRemoteDevice({ deviceId, deviceName, authToken }) {
    assert.ok(this.executorBinary, 'Remote executor binary is not ready')
    const home = join(resultDir, `generated-remote-device-${deviceId}`)
    const codexHome = join(home, 'codex')
    const logPath = join(resultDir, `generated-remote-device-${deviceId}.log`)
    await writeCodexConfig(codexHome, this.modelServerUrl)
    const env = this.executorEnv({
      deviceId,
      deviceName,
      deviceType: 'remote',
      home,
      codexHome,
      logFile: `generated-remote-device-${deviceId}-runtime.log`,
      authToken,
    })
    delete env.WEGENT_APP_IPC_DEVICE_ID
    const executor = spawn(this.executorBinary, [], {
      cwd: weworkDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.generatedRemoteExecutors.push(executor)
    await Promise.all([
      appendProcessOutput(executor.stdout, logPath),
      appendProcessOutput(executor.stderr, logPath),
    ])
    await this.waitForDevice(deviceId, logPath)
  }

  async seedCloudProtocolModels() {
    const items = [
      ...CLOUD_MODEL_CASES.map(model => ({
        name: model.optionIds[0],
        env: {
          model: model.protocol === 'anthropic' ? 'claude' : 'openai',
          model_id: model.modelId,
          base_url: `${this.modelServerUrl}/v1`,
          api_key: MODEL_API_KEY,
        },
        is_active: true,
        wework_available: true,
        protocol:
          model.protocol === 'responses'
            ? 'openai-responses'
            : model.protocol === 'chat'
              ? 'openai'
              : 'anthropic-messages',
        ...(model.protocol === 'responses'
          ? { api_format: 'responses' }
          : model.protocol === 'chat'
            ? { api_format: 'chat/completions' }
            : {}),
      })),
      {
        name: CLOUD_PUBLIC_MODEL_NAME,
        env: {
          model: 'openai',
          model_id: 'desktop-e2e-public-upstream-model',
          base_url: `${this.modelServerUrl}/v1`,
          api_key: MODEL_API_KEY,
        },
        is_active: true,
        wework_available: true,
        protocol: 'openai-responses',
        api_format: 'responses',
      },
    ]
    await fetchJson(`${this.backendUrl}/api/models/batch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(items),
    })
  }

  async seedCloudVisionSidecarModels() {
    const headers = {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
    }
    const createModel = model =>
      fetchJson(`${this.backendUrl}/api/v1/namespaces/default/models`, {
        method: 'POST',
        headers,
        body: JSON.stringify(model),
      })

    await createModel({
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: {
        name: 'desktop-e2e-cloud-vision-sidecar',
        namespace: 'default',
        displayName: 'Desktop E2E Cloud Vision Sidecar',
      },
      spec: {
        modelConfig: {
          env: {
            model: 'openai',
            model_id: CLOUD_VISION_SIDECAR_CASE.sidecarModelId,
            base_url: `${this.modelServerUrl}/v1`,
            api_key: MODEL_API_KEY,
          },
        },
        protocol: 'openai',
        apiFormat: 'chat/completions',
        modelType: 'llm',
        isWeworkAvailable: true,
        modelCapabilities: {
          supportsImage: true,
        },
      },
    })

    const unifiedModels = await fetchJson(
      `${this.backendUrl}/api/models/unified?include_config=true&scope=all&model_category_type=llm&client_origin=wework`,
      { headers }
    )
    const sidecar = unifiedModels.data?.find(
      model => model.name === 'desktop-e2e-cloud-vision-sidecar' && model.type === 'user'
    )
    assert.ok(sidecar, 'The cloud vision sidecar fixture was not returned by model aggregation')
    assert.equal(
      typeof sidecar.resourceUserId,
      'number',
      'The cloud vision sidecar fixture did not expose its resource owner'
    )

    await createModel({
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: {
        name: CLOUD_VISION_SIDECAR_CASE.mainOptionId,
        namespace: 'default',
        displayName: CLOUD_VISION_SIDECAR_CASE.mainLabel,
      },
      spec: {
        modelConfig: {
          env: {
            model: 'openai',
            model_id: CLOUD_VISION_SIDECAR_CASE.mainModelId,
            base_url: `${this.modelServerUrl}/v1`,
            api_key: MODEL_API_KEY,
          },
          visionSidecarModel: {
            modelName: sidecar.name,
            modelType: sidecar.type,
            namespace: sidecar.namespace,
            resourceUserId: sidecar.resourceUserId,
            apiFormat: 'openai-chat-completions',
          },
        },
        protocol: 'openai-responses',
        apiFormat: 'responses',
        modelType: 'llm',
        isWeworkAvailable: true,
      },
    })

    await createModel({
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: {
        name: CLOUD_MULTIMODAL_VISION_CASE.mainOptionId,
        namespace: 'default',
        displayName: CLOUD_MULTIMODAL_VISION_CASE.mainLabel,
      },
      spec: {
        modelConfig: {
          env: {
            model: 'openai',
            model_id: CLOUD_MULTIMODAL_VISION_CASE.mainModelId,
            base_url: `${this.modelServerUrl}/v1`,
            api_key: MODEL_API_KEY,
          },
        },
        protocol: 'openai-responses',
        apiFormat: 'responses',
        modelType: 'llm',
        isWeworkAvailable: true,
        modelCapabilities: {
          supportsImage: true,
        },
      },
    })
  }

  async setCodexUpstreamProtocol(protocol) {
    await writeCodexConfig(
      this.remoteCodexHome,
      this.modelServerUrl,
      '',
      codexUpstreamApiFormat(protocol)
    )
    await this.restartCloudExecutor()
  }

  async waitForDevice(deviceId, logPath) {
    await this.waitForDeviceStatus(deviceId, 'online', logPath)
  }

  async waitForDeviceStatus(deviceId, expectedStatus, logPath) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
      try {
        const response = await fetch(`${this.backendUrl}/api/devices`, {
          headers: { Authorization: `Bearer ${this.authToken}` },
        })
        if (response.ok) {
          const devices = await response.json()
          const device = devices.items?.find(item => item.device_id === deviceId)
          if (device?.status === expectedStatus) return device
        }
      } catch {
        // The backend may briefly reset a readiness connection while executors register.
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    throw new Error(`Real ${deviceId} executor did not reach ${expectedStatus}; see ${logPath}`)
  }

  async stopRemoteDockerExecutorAndWaitOffline() {
    assert.ok(this.remoteDockerExecutor, 'Remote Docker executor is not running')
    const remoteDockerExecutor = this.remoteDockerExecutor
    this.remoteDockerExecutor = null
    await stopProcessGroup(remoteDockerExecutor)
    await this.waitForDeviceStatus(
      REMOTE_DOCKER_DEVICE_ID,
      'offline',
      this.remoteDockerExecutorLogPath
    )
  }

  async waitForWorkspaceRemoved(workspacePath) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
      const response = await fetch(`${this.backendUrl}/api/runtime-work`, {
        headers: { Authorization: `Bearer ${this.authToken}` },
      })
      if (response.ok) {
        const work = await response.json()
        const stillPresent = work.workspaces?.some(
          workspace => workspace.workspacePath === workspacePath
        )
        if (!stillPresent) return
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    throw new Error('The real cloud backend still returned the removed project')
  }

  async aliasCloudDeviceToCurrentApp() {
    const devices = await fetchJson(`${this.backendUrl}/api/devices`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    })
    const localCandidates = (devices.items ?? []).filter(
      device => device.device_id !== CLOUD_DEVICE_ID && device.status === 'online'
    )
    const localDevice =
      localCandidates.find(device => device.device_type === 'app') ?? localCandidates[0]
    assert.ok(localDevice?.device_id, 'The connected local app device was not registered')
    assert.match(
      localDevice.device_id,
      /^[A-Za-z0-9._-]+$/,
      'The connected local app device ID is not safe for the SQLite fixture'
    )

    await runChecked('sqlite3', [
      this.databasePath,
      [
        'UPDATE kinds',
        `SET json = json_set(json, '$.spec.appDeviceId', '${localDevice.device_id}')`,
        `WHERE kind = 'Device' AND name = '${CLOUD_DEVICE_ID}';`,
      ].join(' '),
    ])

    const updated = await fetchJson(`${this.backendUrl}/api/devices`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    })
    const cloudDevice = updated.items?.find(device => device.device_id === CLOUD_DEVICE_ID)
    assert.equal(
      cloudDevice?.app_device_id,
      localDevice.device_id,
      'The cloud route was not associated with the connected local app device'
    )
  }

  async cancelRunningTasks() {
    if (!this.backendUrl || !this.authToken) return
    const work = await fetchJson(`${this.backendUrl}/api/runtime-work`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    })
    const workspaces = [
      ...(work.projects ?? []).flatMap(project => project.deviceWorkspaces ?? []),
      ...(work.chats ?? []),
    ]
    const runningTasks = workspaces.flatMap(workspace =>
      (workspace.tasks ?? [])
        .filter(task => task.running)
        .map(task => ({
          deviceId: workspace.deviceId,
          taskId: task.taskId,
          workspacePath: task.workspacePath,
        }))
    )
    await Promise.all(
      runningTasks.map(address =>
        fetchJson(`${this.backendUrl}/api/runtime-work/cancel`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(address),
        })
      )
    )
  }

  async stop() {
    try {
      await this.cancelRunningTasks()
    } catch (error) {
      await appendFile(
        this.remoteExecutorLogPath,
        `Cloud E2E cleanup could not cancel running tasks: ${String(error)}\n`
      )
    }
    await stopProcessGroup(this.remoteExecutor)
    await stopProcessGroup(this.remoteDockerExecutor)
    await Promise.all(this.generatedRemoteExecutors.map(executor => stopProcessGroup(executor)))
    await stopProcess(this.backend)
    await this.pluginObjectStorage?.stop()
    await stopProcess(this.redis)
  }
}

async function verifyLocalExecutorUsesCloudSocketUrl(control, cloudEnvironment) {
  assert.notEqual(
    cloudEnvironment.socketUrl,
    cloudEnvironment.backendUrl,
    'Cloud E2E must use distinct backend and socket URLs'
  )
  const startedAt = Date.now()
  let executorLog = null
  while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
    executorLog = JSON.parse(await control.command('getLocalExecutorLog', 'body'))
    if (
      executorLog.backendUrl === cloudEnvironment.backendUrl &&
      executorLog.socketUrl === cloudEnvironment.socketUrl
    ) {
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  assert.deepEqual(
    {
      backendUrl: executorLog?.backendUrl ?? null,
      socketUrl: executorLog?.socketUrl ?? null,
    },
    {
      backendUrl: cloudEnvironment.backendUrl,
      socketUrl: cloudEnvironment.socketUrl,
    },
    'Local executor did not apply the server-downlinked socket URL'
  )
}

export { RealCloudEnvironment, startRedisServer, verifyLocalExecutorUsesCloudSocketUrl }
