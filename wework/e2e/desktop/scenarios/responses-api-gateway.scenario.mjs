import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CLOUD_DEVICE_ID, CLOUD_PUBLIC_MODEL_NAME } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const TEAM = 'responses-gateway-chat'
const CHAT_PROMPT = `RESPONSES_GATEWAY_CHAT_${process.pid}`
const CHAT_RESULT = `CHAT_DISPATCH_PERSISTED_${process.pid}`
const RUNTIME_PROMPT = `RESPONSES_GATEWAY_RUNTIME_${process.pid}`
const RUNTIME_RESULT = `NATIVE_RUNTIME_COMPLETED_${process.pid}`

// Only the upstream model is simulated. HTTP, auth, dispatch, MySQL, Redis,
// Chat Shell and the desktop Runtime all use the common Cloud E2E services.
export function createDesktopScenario({
  checkpoint,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  resultDir,
}) {
  let cloud, environment, user, apiKey
  const modelRequests = []
  const evidence = { checkpoint: 'responses-api-gateway', hostCheckpoint: checkpoint }

  async function request(path, body, token = cloud.authToken) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(body?.input ? modelResponseTimeoutMs : uiTimeoutMs),
    })
    const text = await response.text()
    assert.ok(response.ok, `${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function until(load, accept, message) {
    const deadline = Date.now() + modelResponseTimeoutMs
    let latest
    while (Date.now() < deadline) {
      latest = await load()
      if (accept(latest)) return latest
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.fail(`${message}: ${JSON.stringify(latest)}`)
  }

  function outputText(response) {
    return response.output
      .filter(item => item.type === 'message' && item.role === 'assistant')
      .flatMap(item => item.content)
      .filter(part => part.type === 'output_text')
      .map(part => part.text)
      .join('')
  }

  async function databaseCounts() {
    return cloud.queryDatabase(
      'SELECT (SELECT COUNT(*) FROM tasks WHERE user_id = %s) AS tasks, ' +
        '(SELECT COUNT(*) FROM subtasks WHERE user_id = %s) AS subtasks',
      [user.id, user.id]
    )
  }

  async function verifyServiceUserProvisioning() {
    const username = `responses-service-user-${process.pid}`
    const created = await request('/admin/service-keys', {
      name: 'responses-e2e',
      description: 'Responses gateway service-user regression',
    })
    const before = await cloud.queryDatabase(
      'SELECT id, user_name, email, is_active, auth_source FROM users WHERE user_name = %s',
      [username]
    )
    assert.deepEqual(before, [])

    const response = await fetch(`${cloud.backendUrl}/api/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${created.key}`,
        'wegent-username': username,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: `default#${TEAM}`, input: CHAT_PROMPT, background: true }),
      signal: AbortSignal.timeout(modelResponseTimeoutMs),
    })
    const responseText = await response.text()
    assert.ok(response.ok, `service-key create: ${response.status} ${responseText}`)
    const createdResponse = JSON.parse(responseText)
    assert.equal(createdResponse.status, 'queued')

    const users = await cloud.queryDatabase(
      'SELECT id, user_name, email, is_active, auth_source FROM users WHERE user_name = %s',
      [username]
    )
    assert.equal(users.length, 1, JSON.stringify(users))
    assert.equal(users[0].user_name, username)
    assert.equal(users[0].email, `${username}@api.auto`)
    assert.equal(users[0].is_active, 1)
    assert.equal(users[0].auth_source, 'api:responses-e2e')

    const tasks = await cloud.queryDatabase(
      'SELECT id, user_id FROM tasks WHERE user_id = %s ORDER BY id DESC LIMIT 1',
      [users[0].id]
    )
    assert.equal(tasks.length, 1, JSON.stringify(tasks))
    assert.equal(tasks[0].user_id, users[0].id)
    evidence.serviceUser = { username, userId: users[0].id, taskId: tasks[0].id }
    return username
  }

  async function verifyRejectedCreates(deviceId, model) {
    const before = await databaseCounts()
    const conversationsPath = `/v1/conversations?device_id=${encodeURIComponent(deviceId)}`
    const conversations = await request(conversationsPath, null, apiKey)
    const dispatched = modelRequests.length
    for (const body of [
      { model: `default#${TEAM}`, input: CHAT_PROMPT, background: true },
      {
        model,
        input: RUNTIME_PROMPT,
        execution: { type: 'wework', device_id: deviceId },
      },
    ]) {
      for (const token of [null, 'wg-invalid-responses-e2e-key']) {
        const response = await fetch(`${cloud.backendUrl}/api/v1/responses`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(uiTimeoutMs),
        })
        assert.equal(response.status, 401, await response.text())
      }
    }
    assert.deepEqual(await databaseCounts(), before, 'Unauthorized creation wrote MySQL rows')
    assert.deepEqual(
      (await request(conversationsPath, null, apiKey)).data,
      conversations.data,
      'Unauthorized creation dispatched a native Runtime task'
    )
    assert.equal(modelRequests.length, dispatched, 'Unauthorized creation reached a model')
    evidence.auth = { rejected: 4, before, after: await databaseCounts() }
  }

  async function verifyChat() {
    const created = await request(
      '/v1/responses',
      { model: `default#${TEAM}`, input: CHAT_PROMPT, background: true },
      apiKey
    )
    // The shared environment's package mode dispatches asynchronously.
    assert.equal(created.status, 'queued', JSON.stringify(created))
    assert.match(created.id, /^resp_\d+$/)
    const taskId = Number(created.id.slice(5))
    const tasks = await until(
      () =>
        cloud.queryDatabase(
          'SELECT id, user_id, kind, namespace, ' +
            "JSON_UNQUOTE(JSON_EXTRACT(json, '$.status.status')) AS status FROM tasks " +
            'WHERE id = %s AND user_id = %s AND namespace = %s',
          [taskId, user.id, 'default']
        ),
      rows => {
        assert.notEqual(rows[0]?.status, 'FAILED', JSON.stringify(rows))
        return rows.length === 1 && rows[0].status === 'COMPLETED'
      },
      'Chat Shell did not persist a completed Task'
    )
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].kind, 'Task')
    assert.equal(tasks[0].status, 'COMPLETED')
    const subtasks = await until(
      () =>
        cloud.queryDatabase(
          'SELECT id, user_id, role, status, prompt, result FROM subtasks ' +
            'WHERE task_id = %s AND user_id = %s ORDER BY id',
          [taskId, user.id]
        ),
      rows => rows.some(row => row.role === 'ASSISTANT' && row.status === 'COMPLETED'),
      'Chat Shell did not persist a completed assistant message'
    )
    assert.equal(subtasks.length, 2)
    assert.equal(subtasks[0].role, 'USER')
    assert.equal(subtasks[0].prompt, CHAT_PROMPT)
    assert.equal(subtasks[1].role, 'ASSISTANT')
    assert.equal(subtasks[1].status, 'COMPLETED')
    const result =
      typeof subtasks[1].result === 'string' ? JSON.parse(subtasks[1].result) : subtasks[1].result
    assert.equal(result.value, CHAT_RESULT)
    assert.ok(
      modelRequests.some(row => row.kind === 'chat'),
      'Chat Shell never called the model'
    )
    const retrieved = await request(`/v1/responses/${created.id}`, null, apiKey)
    assert.equal(retrieved.id, created.id)
    assert.equal(retrieved.status, 'completed')
    assert.equal(outputText(retrieved), CHAT_RESULT)
    evidence.chat = { response: retrieved, tasks, subtasks }
    return created.id
  }

  async function verifyRuntime(deviceId, model) {
    const created = await request(
      '/v1/responses',
      {
        model,
        input: RUNTIME_PROMPT,
        execution: { type: 'wework', device_id: deviceId, title: 'Responses gateway E2E' },
      },
      apiKey
    )
    assert.equal(created.status, 'completed', JSON.stringify(created))
    assert.equal(outputText(created), RUNTIME_RESULT)
    const [actualDevice, taskId, messageId] = JSON.parse(
      Buffer.from(created.id.slice(5), 'base64url').toString('utf8')
    )
    assert.equal(actualDevice, deviceId)
    assert.ok(taskId && messageId)
    const runtime = await until(
      () => environment.runtimeTask(taskId),
      value => {
        assert.notEqual(value?.status, 'failed', JSON.stringify(value))
        return value?.status === 'done' && !value.running
      },
      'The real remote Runtime did not complete the API-created task'
    )
    assert.equal(runtime.taskId, taskId)
    const transcript = await request('/runtime-work/transcript', {
      deviceId,
      taskId,
      limit: 100,
      includeFullContent: true,
    })
    assert.ok(
      transcript.messages.some(
        message => message.clientUserMessageId === messageId && message.role === 'user'
      ),
      'The real Runtime did not persist the API user-message identity'
    )
    assert.ok(
      transcript.messages.some(
        message => message.role === 'assistant' && JSON.stringify(message).includes(RUNTIME_RESULT)
      ),
      'The real Runtime did not persist the model result'
    )
    assert.ok(
      modelRequests.some(row => row.kind === 'runtime'),
      'Native Codex never called the model'
    )
    // Native turns are read through their production conversation API. The
    // retained Rust Responses GET contract uses numeric Wegent task IDs.
    const conversation = await request(`/v1/conversations/${created.conversation.id}`, null, apiKey)
    assert.equal(conversation.id, created.conversation.id)
    const retrieved = conversation.latest_response
    assert.equal(retrieved.id, created.id)
    assert.equal(retrieved.status, 'completed')
    assert.equal(outputText(retrieved), RUNTIME_RESULT)
    assert.equal(retrieved.conversation.id, created.conversation.id)
    evidence.runtime = {
      response: retrieved,
      task: { taskId, status: runtime.status, running: runtime.running },
      messages: transcript.messages.map(({ id, clientUserMessageId, role, content }) => ({
        id,
        clientUserMessageId,
        role,
        content,
      })),
    }
  }

  async function verifyRouting(responseId, successfulRustPosts) {
    const pythonPosts = log =>
      log
        .split('\n')
        .filter(
          line => line.includes('response: POST /api/v1/responses ') && line.includes(' 200 ')
        ).length
    const rustPosts = log =>
      log
        .split('\n')
        .filter(line => line.includes('[API] POST /api/v1/responses ') && line.includes(' 200 '))
        .length
    await until(
      async () => ({
        python: await readFile(environment.backendLogPath, 'utf8'),
        rust: await readFile(
          join(dirname(environment.backendLogPath), 'backend-rs-logs', 'api.log'),
          'utf8'
        ),
      }),
      logs =>
        pythonPosts(logs.python) === 0 &&
        rustPosts(logs.rust) === successfulRustPosts &&
        logs.rust.includes(`[API] GET /api/v1/responses/${responseId} `),
      'The real Rust POST and GET ownership was not observed in process logs'
    )
    const python = await readFile(environment.backendLogPath, 'utf8')
    assert.ok(
      !python.includes(`request : GET /api/v1/responses/${responseId} `),
      'The follow-up GET fell back to Python'
    )
    evidence.routing = {
      successfulRustPosts,
      successfulPythonPosts: 0,
      rustGet: responseId,
      pythonGet: false,
    }
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(value) {
      cloud = value
      await request('/admin/setup-complete', {})
      user = await request('/users/me')
      apiKey = (await request('/api-keys', { name: 'responses-gateway-e2e' })).key
      const bot = await request('/bots', {
        name: TEAM,
        shell_name: 'Chat',
        agent_config: { bind_model: 'desktop-e2e-cloud-chat', bind_model_type: 'public' },
        system_prompt: 'Return the model response without using tools.',
        inherit_base_capabilities: false,
        namespace: 'default',
        is_active: true,
      })
      await request('/teams', {
        name: TEAM,
        bots: [{ bot_id: bot.id, role: 'worker' }],
        bind_mode: ['chat'],
        namespace: 'default',
        is_active: true,
        requires_workspace: false,
      })
    },
    setCloudEnvironment(value) {
      environment = value
    },
    async handleHttp(req, response, url) {
      if (
        req.method !== 'POST' ||
        !['/v1/chat/completions', '/v1/responses', '/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(req)
      const input = JSON.stringify(body)
      const chat = url.pathname.endsWith('/chat/completions') && input.includes(CHAT_PROMPT)
      const runtime = !chat && input.includes(RUNTIME_PROMPT)
      if (!chat && !runtime) return false
      const id = `responses-gateway-model-${modelRequests.length}`
      modelRequests.push({ kind: chat ? 'chat' : 'runtime', path: url.pathname, model: body.model })
      if (chat && !body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: CHAT_RESULT },
                finish_reason: 'stop',
              },
            ],
          })
        )
        return true
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (chat) {
        const chunk = (delta, finishReason = null) =>
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`
        response.end(
          chunk({ role: 'assistant', content: CHAT_RESULT }) +
            chunk({}, 'stop') +
            'data: [DONE]\n\n'
        )
      } else {
        response.end(
          createSse([responseCreated(id), assistantMessage(RUNTIME_RESULT), responseCompleted(id)])
        )
      }
      return true
    },
    async verify() {
      const started = Date.now()
      evidence.environment = {
        processId: process.pid,
        backendUrl: environment.backendUrl,
        backendLogPath: environment.backendLogPath,
        runtimeLogPath: environment.remoteExecutorLogPath,
      }
      try {
        const device = await environment.device(CLOUD_DEVICE_ID)
        assert.equal(device.status, 'online', 'The real remote Runtime must be connected')
        const models = await request('/v1/models?execution=wework', null, apiKey)
        const model = models.data.find(candidate => candidate.name === CLOUD_PUBLIC_MODEL_NAME)
        assert.ok(model, 'The real API model catalog did not expose the native model fixture')
        await verifyRejectedCreates(device.device_id, model.id)
        await verifyServiceUserProvisioning()
        const responseId = await verifyChat()
        await verifyRuntime(device.device_id, model.id)
        await verifyRouting(responseId, 3)
      } finally {
        evidence.durationMs = Date.now() - started
        evidence.modelRequests = modelRequests
        await writeFile(
          join(resultDir, 'responses-api-gateway.json'),
          JSON.stringify(evidence, null, 2)
        )
      }
    },
  }
}

// Run the same independent checkpoint inside an already bootstrapped Cloud
// lifecycle. Each invocation creates its own data; only model handling is scoped.
export async function verifyResponsesApiGateway(control, environment, options) {
  const scenario = createDesktopScenario(options)
  const previous = control.desktopScenario
  const started = Date.now()
  console.log(`[desktop-e2e] START responses-api-gateway (shared Cloud: ${options.checkpoint})`)
  try {
    control.setDesktopScenario({
      ...previous,
      async handleHttp(request, response, url) {
        return (
          (await scenario.handleHttp(request, response, url)) ||
          (await previous?.handleHttp?.(request, response, url)) ||
          false
        )
      },
    })
    await scenario.prepareCloud(environment)
    scenario.setCloudEnvironment(environment)
    await scenario.verify()
    console.log(
      `[desktop-e2e] PASS responses-api-gateway: duration=${Date.now() - started}ms, assertion-errors=none, shared-cloud=${options.checkpoint}, evidence=${options.resultDir}`
    )
  } finally {
    control.setDesktopScenario(previous)
  }
}
