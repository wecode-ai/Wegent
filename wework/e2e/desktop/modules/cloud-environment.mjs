import { codexUpstreamApiFormat, writeCodexConfig } from './desktop-build-flows.mjs'

import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'

import {
  CLOUD_DEVICE_ID,
  CLOUD_MODEL_CASES,
  CLOUD_MULTIMODAL_VISION_CASE,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_VISION_SIDECAR_CASE,
  DEFAULT_STEP_TIMEOUT_MS,
  MODEL_API_KEY,
  WORKBENCH_READY_TIMEOUT_MS,
  appendFile,
  appendProcessOutput,
  assert,
  createServer,
  dirname,
  fetchJson,
  join,
  mkdir,
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
  constructor({ codexBinary, modelServerUrl, scenarioConfigToml = '', workspacePath }) {
    this.codexBinary = codexBinary
    this.modelServerUrl = modelServerUrl
    this.scenarioConfigToml = scenarioConfigToml
    this.workspacePath = workspacePath
  }

  async startBackend() {
    this.redisPort = await reservePort()
    this.backendPort = await reservePort()
    this.backendUrl = `http://127.0.0.1:${this.backendPort}`
    this.socketUrl = `http://localhost:${this.backendPort}`
    this.databasePath = join(resultDir, 'cloud-backend.sqlite3')
    this.backendLogPath = join(resultDir, 'cloud-backend.log')
    this.redisLogPath = join(resultDir, 'cloud-redis.log')
    this.remoteExecutorLogPath = join(resultDir, 'cloud-executor.log')
    this.pluginObjectStorage = new LocalPluginObjectStorage()
    await this.pluginObjectStorage.start()

    this.redis = spawn(
      'redis-server',
      ['--port', String(this.redisPort), '--save', '', '--appendonly', 'no'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    await Promise.all([
      appendProcessOutput(this.redis.stdout, this.redisLogPath),
      appendProcessOutput(this.redis.stderr, this.redisLogPath),
    ])

    const backendEnv = {
      ...process.env,
      DATABASE_URL: `sqlite:///${this.databasePath}`,
      REDIS_URL: `redis://127.0.0.1:${this.redisPort}/0`,
      SECRET_KEY: `wework-desktop-e2e-${process.pid}`,
      INTERNAL_SERVICE_TOKEN: `wework-desktop-e2e-internal-${process.pid}`,
      GIT_TOKEN_AES_KEY: '12345678901234567890123456789012',
      GIT_TOKEN_AES_IV: '1234567890123456',
      FRONTEND_URL: this.modelServerUrl,
      CHAT_SHELL_URL: this.modelServerUrl,
      CHAT_SHELL_TOKEN: MODEL_API_KEY,
      WEGENT_SOCKET_URL: this.socketUrl,
      DB_AUTO_MIGRATE: 'false',
      INIT_DATA_ENABLED: 'true',
      ATTACHMENT_S3_ENDPOINT: this.pluginObjectStorage.endpoint,
      ATTACHMENT_S3_ACCESS_KEY: 'desktop-e2e-access-key',
      ATTACHMENT_S3_SECRET_KEY: 'desktop-e2e-secret-key',
      ATTACHMENT_S3_USE_SSL: 'false',
      PLUGIN_PUBLISH_ENABLED: 'true',
    }
    await runChecked('uv', ['run', 'alembic', 'upgrade', 'head'], {
      cwd: join(repoDir, 'backend'),
      env: backendEnv,
    })
    this.backend = spawn(
      'uv',
      ['run', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(this.backendPort)],
      {
        cwd: join(repoDir, 'backend'),
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

  async seedPluginAutoUpdateFixtures(count = 6) {
    if (this.pluginAutoUpdateFixturesSeeded) return
    const headers = {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
    }
    for (let index = 1; index <= count; index += 1) {
      const slug = `desktop-e2e-auto-update-${index}`
      const first = await this.publishPluginRelease({ headers, slug, version: '1.0.0' })
      await fetchJson(
        `${this.backendUrl}/api/admin/plugins/submissions/${first.submissionId}/review`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ approved: true, note: 'Desktop E2E initial release' }),
        }
      )
      await fetchJson(
        `${this.backendUrl}/api/plugins/marketplace/${first.pluginId}/install?device_id=${CLOUD_DEVICE_ID}`,
        { method: 'POST', headers }
      )
      const latest = await this.publishPluginRelease({ headers, slug, version: '2.0.0' })
      await fetchJson(
        `${this.backendUrl}/api/admin/plugins/submissions/${latest.submissionId}/review`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ approved: true, note: 'Desktop E2E update release' }),
        }
      )
    }
    this.pluginAutoUpdateFixturesSeeded = true
  }

  async publishPluginRelease({ headers, slug, version }) {
    const packageRoot = join(resultDir, 'plugin-auto-update-fixtures', `${slug}-${version}`)
    const manifestDir = join(packageRoot, '.codex-plugin')
    const packagePath = join(resultDir, 'plugin-auto-update-fixtures', `${slug}-${version}.zip`)
    await mkdir(manifestDir, { recursive: true })
    await writeFile(
      join(manifestDir, 'plugin.json'),
      `${JSON.stringify({ name: slug, version, description: `Desktop E2E ${slug}` }, null, 2)}\n`,
      'utf8'
    )
    await rm(packagePath, { force: true })
    await runChecked('zip', ['-q', '-r', packagePath, '.'], { cwd: packageRoot })
    const packageBytes = await readFile(packagePath)
    const initialized = await fetchJson(`${this.backendUrl}/api/plugins/submissions/init`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        slug,
        displayName: `Auto Update ${slug.split('-').at(-1)}`,
        version,
        filename: `${slug}.zip`,
        sha256: createHash('sha256').update(packageBytes).digest('hex'),
        sizeBytes: packageBytes.length,
        visibility: 'workspace',
      }),
    })
    const upload = await fetch(initialized.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip' },
      body: packageBytes,
    })
    assert.equal(upload.ok, true, `Plugin E2E upload failed with HTTP ${upload.status}`)
    await fetchJson(
      `${this.backendUrl}/api/plugins/submissions/${initialized.submissionId}/complete`,
      { method: 'POST', headers }
    )
    return initialized
  }

  async assertPluginAutoUpdateComplete(expectedCount = 6) {
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
  }

  async startRemoteExecutor(executorBinary) {
    const remoteHome = join(resultDir, 'cloud-executor-home')
    this.remoteCodexHome = join(remoteHome, 'codex')
    await writeCodexConfig(this.remoteCodexHome, this.modelServerUrl, this.scenarioConfigToml)
    const remoteEnv = {
      ...process.env,
      CODEX_BIN: this.codexBinary,
      CODEX_HOME: this.remoteCodexHome,
      HOME: remoteHome,
      WEGENT_CODEX_HOME: this.remoteCodexHome,
      WEGENT_EXECUTOR_HOME: remoteHome,
      WEGENT_EXECUTOR_LOG_DIR: resultDir,
      WEGENT_EXECUTOR_LOG_FILE: 'cloud-executor-runtime.log',
      EXECUTOR_MODE: 'local',
      WEGENT_BACKEND_URL: this.backendUrl,
      WEGENT_SOCKET_URL: this.socketUrl,
      WEGENT_AUTH_TOKEN: this.authToken,
      DEVICE_ID: CLOUD_DEVICE_ID,
      DEVICE_NAME: 'Wework E2E Cloud Device',
      DEVICE_TYPE: 'cloud',
      BIND_SHELL: 'claudecode',
      LOCAL_WORKSPACE_ROOT: dirname(this.workspacePath),
      WEGENT_WORKSPACE_ROOTS: this.workspacePath,
      WEWORK_E2E_MODEL_API_KEY: MODEL_API_KEY,
      DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
      DEVICE_SESSION_GATEWAY_PORT: '0',
    }
    delete remoteEnv.WEGENT_APP_IPC_DEVICE_ID
    this.remoteExecutor = spawn(executorBinary, [], {
      cwd: weworkDir,
      env: remoteEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    await Promise.all([
      appendProcessOutput(this.remoteExecutor.stdout, this.remoteExecutorLogPath),
      appendProcessOutput(this.remoteExecutor.stderr, this.remoteExecutorLogPath),
    ])
    await this.waitForDevice()
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
  }

  async waitForDevice() {
    const startedAt = Date.now()
    while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
      const response = await fetch(`${this.backendUrl}/api/devices`, {
        headers: { Authorization: `Bearer ${this.authToken}` },
      })
      if (response.ok) {
        const devices = await response.json()
        const device = devices.items?.find(item => item.device_id === CLOUD_DEVICE_ID)
        if (device?.status === 'online') return
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    throw new Error(`Real cloud executor did not register; see ${this.remoteExecutorLogPath}`)
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

export { RealCloudEnvironment, verifyLocalExecutorUsesCloudSocketUrl }
