import { codexUpstreamApiFormat, writeCodexConfig } from './desktop-build-flows.mjs'

import {
  CLOUD_DEVICE_ID,
  CLOUD_MODEL_CASES,
  CLOUD_MULTIMODAL_VISION_CASE,
  CLOUD_VISION_SIDECAR_CASE,
  DEFAULT_STEP_TIMEOUT_MS,
  MODEL_API_KEY,
  WORKBENCH_READY_TIMEOUT_MS,
  appendFile,
  appendProcessOutput,
  assert,
  dirname,
  fetchJson,
  join,
  repoDir,
  reservePort,
  resultDir,
  runChecked,
  spawn,
  stopProcess,
  stopProcessGroup,
  waitForUrl,
  weworkDir,
} from './shared.mjs'

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
      WEGENT_SOCKET_URL: this.socketUrl,
      DB_AUTO_MIGRATE: 'false',
      INIT_DATA_ENABLED: 'true',
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
    const items = CLOUD_MODEL_CASES.map(model => ({
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
    }))
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

  async seedDevelopmentWorkflowFixture() {
    const headers = {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
    }
    const post = (path, body) =>
      fetchJson(`${this.backendUrl}/api${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    const put = (path, body) =>
      fetchJson(`${this.backendUrl}/api${path}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      })
    const project = await post('/v1/cloud-projects', {
      projectKey: 'AIDEV',
      name: 'AI Development Workflow',
      description: 'Desktop E2E project for the complete AI development workflow.',
      taskProvider: 'local',
      visibility: 'private',
    })
    const repository = await post(`/v1/cloud-projects/${project.id}/repositories`, {
      provider: 'github',
      repositoryIdentity: 'wegent/wegent',
      repositoryUrl: 'https://github.com/wegent/wegent.git',
      defaultBranch: 'main',
      defaultExecutionTarget: { type: 'managed_container' },
      workspacePolicy: { cleanup: 'after_merge' },
      gitPolicy: { branchTemplate: 'feature/{projectKey}-{taskId}-{slug}' },
      providerSettings: { requireCi: true, requireReview: true },
    })
    const workflow = await post(`/v1/cloud-projects/${project.id}/workflows`, {
      name: 'Complete AI delivery',
      description: 'Plan approval, CI, review, merge, and completion.',
      triggerMode: 'manual',
      repositoryBindingId: repository.id,
      failurePolicy: 'pause',
      isDefault: true,
      stages: [
        {
          key: 'plan',
          name: 'Plan approval',
          nodes: [{ key: 'approve-plan', name: 'Approve plan', type: 'human_gate' }],
        },
        {
          key: 'quality',
          name: 'Quality gates',
          execution: 'parallel',
          completion: 'all',
          nodes: [
            {
              key: 'ci',
              name: 'CI checks',
              type: 'ci_gate',
              condition: 'ci_passed',
            },
            {
              key: 'review',
              name: 'Code review',
              type: 'ci_gate',
              condition: 'review_approved',
            },
          ],
        },
        {
          key: 'merge',
          name: 'Merge',
          nodes: [
            {
              key: 'merged',
              name: 'PR merged',
              type: 'merge',
              condition: 'pr_merged',
            },
          ],
        },
        {
          key: 'complete',
          name: 'Complete',
          nodes: [{ key: 'done', name: 'Complete task', type: 'complete' }],
        },
      ],
    })
    const automation = await post(`/v1/cloud-projects/${project.id}/workflow-automations`, {
      name: 'Daily dependency maintenance',
      description: 'Create a board task and run the complete delivery workflow.',
      triggerType: 'cron',
      triggerConfig: { expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' },
      workflowId: workflow.id,
      repositoryBindingId: repository.id,
      executionTarget: { type: 'managed_container' },
      workspaceMode: 'git_worktree',
      taskTemplate: {
        title: 'Automated dependency maintenance',
        description: 'Update dependencies and verify the complete delivery path.',
        priority: 'high',
      },
      payloadMapping: { title: 'task.title', description: 'task.description' },
      enabled: true,
    })
    const task = await post(`/v1/cloud-projects/${project.id}/loop-items`, {
      title: 'Implement complete AI development workflow',
      description: 'Verify planning, development, CI, review, merge, and cleanup.',
      status: 'in_progress',
      priority: 'high',
    })
    await put(`/v1/cloud-projects/${project.id}/loop-items/${task.id}/execution-binding`, {
      workflowId: workflow.id,
      repositoryBindingId: repository.id,
      executionTarget: { type: 'managed_container' },
      workspaceMode: 'git_worktree',
    })
    const run = await post(
      `/v1/cloud-projects/${project.id}/loop-items/${task.id}/workflow/start`,
      { idempotencyKey: `desktop-e2e-${process.pid}` }
    )
    return { project, repository, workflow, automation, task, run }
  }

  async submitDevelopmentProviderEvent(fixture, event) {
    return fetchJson(
      `${this.backendUrl}/api/v1/cloud-projects/${fixture.project.id}/repositories/${fixture.repository.id}/provider-events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      }
    )
  }

  async getDevelopmentFixture(fixture) {
    return fetchJson(
      `${this.backendUrl}/api/v1/cloud-projects/${fixture.project.id}/loop-items/${fixture.task.id}/development`,
      {
        headers: { Authorization: `Bearer ${this.authToken}` },
      }
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
