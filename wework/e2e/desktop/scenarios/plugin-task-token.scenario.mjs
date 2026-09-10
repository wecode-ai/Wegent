import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_DEVICE_ID,
  CLOUD_PUBLIC_MODEL_NAME,
  selectE2EModel,
} from '../modules/shared.mjs'
import { currentRuntimeTaskFromDebugSnapshot } from '../modules/workspace-flows.mjs'
import { localHarnessCliPath, localHarnessCliVersion } from '../modules/local-harness-cli.mjs'
import { configureClaude, createRemoteProject } from './claude-runtime.scenario.mjs'
import {
  functionCall,
  namespacedFunctionCall,
  readRequestBody,
  requestContainsToolOutput,
  requestToolSearchResults,
  responseCompleted,
  responseCreated,
  selectToolSearch,
  streamingTextEvents,
  toolSearchResponseEvents,
} from '../modules/response-protocol.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const slug = 'desktop-task-token'
const claudeBinary = localHarnessCliPath(
  join(repository, '.github/claude-code-cli/node_modules/.bin'),
  'claude'
)
const modelSelection = {
  modelName: CLOUD_PUBLIC_MODEL_NAME,
  modelType: 'public',
  options: {
    weworkCloudModelNamespace: 'default',
    weworkCloudModelResourceUserId: '0',
    weworkCloudModelUpstreamApiFormat: 'openai-responses',
  },
}

function textEvents(id, text) {
  const stream = streamingTextEvents(id, text)
  return [
    ...stream.start.slice(1),
    ...stream.chunks.map(delta => ({
      type: 'response.output_text.delta',
      item_id: stream.itemId,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    ...stream.finish.slice(0, -1),
  ]
}

export async function createDesktopScenario({
  resultDir,
  executorHome,
  captureScreenshot,
  workbenchReadyTimeoutMs,
}) {
  let cloud
  let currentCase
  let serviceError
  let remoteProjectReady = false
  const results = new Map()
  const allowedTasks = new Map()
  const tokens = new Set()
  const verifiedTokens = new Map()
  const modelRequests = []
  const root = join(resultDir, slug)
  const service = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405).end()
        return
      }
      const authorization = request.headers.authorization
      assert.ok(authorization?.startsWith('Bearer '), 'Plugin did not send a Bearer token')
      assert.notEqual(authorization, `Bearer ${cloud.authToken}`, 'Plugin received the login token')
      tokens.add(authorization.slice(7))
      let identity = verifiedTokens.get(authorization)
      if (!identity) {
        const identityResponse = await fetch(
          `${cloud.backendUrl}/api/external/mcp-identity/userinfo`,
          {
            headers: { Authorization: authorization },
          }
        )
        assert.equal(identityResponse.status, 200, 'Real backend rejected the plugin TaskToken')
        identity = await identityResponse.json()
        verifiedTokens.set(authorization, identity)
      }
      assert.equal(identity.task?.kind, 'runtime')
      assert.ok(identity.task.id && identity.task.device_id)
      const body = await readRequestBody(request)
      if (body.id === undefined || body.id === null) {
        response.writeHead(202).end()
        return
      }
      let result
      if (body.method === 'initialize') {
        result = {
          protocolVersion: body.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: slug, version: '1.0.0' },
        }
      } else if (body.method === 'tools/list') {
        result = {
          tools: [
            {
              name: 'task_token_probe',
              description: 'Verify TaskToken user and task permission',
              inputSchema: {
                type: 'object',
                properties: { case_id: { type: 'string' } },
                required: ['case_id'],
              },
            },
          ],
        }
      } else if (body.method === 'tools/call') {
        const caseId = body.params.arguments.case_id
        const group = caseId.replace(/-(first|followup|other|fork)$/, '')
        const taskKey = JSON.stringify([identity.id, identity.task])
        if (!allowedTasks.has(group)) allowedTasks.set(group, taskKey)
        const output = { identity, allowed: allowedTasks.get(group) === taskKey }
        results.set(caseId, output)
        await writeFile(
          join(resultDir, 'plugin-task-token-results.json'),
          JSON.stringify(Object.fromEntries(results), null, 2)
        )
        result = {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          isError: !output.allowed,
        }
      } else {
        result = {}
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    } catch (error) {
      serviceError = error
      response.writeHead(500).end('TaskToken fixture rejected the request')
    }
  })
  await new Promise(resolvePromise => service.listen(0, '127.0.0.1', resolvePromise))
  await mkdir(join(root, '.codex-plugin'), { recursive: true })
  await writeFile(
    join(root, '.codex-plugin/plugin.json'),
    JSON.stringify({
      name: slug,
      version: '1.0.0',
      description: 'TaskToken identity regression',
      mcpServers: './.mcp.json',
    })
  )
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({
      business: {
        type: 'http',
        url: `http://127.0.0.1:${service.address().port}/mcp`,
        headers: { Authorization: 'Bearer ${{task_token}}' },
      },
    })
  )

  async function api(path, method = 'GET', body) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    assert.ok(response.ok, `TaskToken API ${path}: HTTP ${response.status}`)
    return response.json()
  }

  async function wait(read, accept, message) {
    const deadline = Date.now() + workbenchReadyTimeoutMs
    while (Date.now() < deadline) {
      if (serviceError) throw serviceError
      const value = await read()
      if (accept(value)) return value
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    throw new Error(message)
  }

  async function runTask(deviceId, runtime, caseId, address) {
    currentCase = caseId
    if (address) {
      const response = await api('/runtime-work/send', 'POST', {
        address,
        message: `TASK_TOKEN_CASE:${caseId}`,
        modelSelection,
      })
      assert.equal(response.accepted, true)
    } else {
      const workspacePath = join(resultDir, `task-token-${caseId}`)
      await mkdir(workspacePath, { recursive: true })
      const response = await api('/runtime-work/create', 'POST', {
        deviceId,
        runtime,
        workspacePath,
        message: `TASK_TOKEN_CASE:${caseId}`,
        title: caseId,
        modelId: modelSelection.modelName,
        modelType: modelSelection.modelType,
        modelOptions: modelSelection.options,
        modelSelection,
      })
      assert.equal(response.accepted, true)
      address = {
        deviceId: response.deviceId,
        taskId: response.taskId,
        workspacePath: response.workspacePath,
      }
    }
    const result = await wait(
      () => results.get(caseId),
      Boolean,
      `${caseId}: plugin MCP was never called`
    )
    assert.equal(result.identity.task.id, address.taskId)
    await wait(
      async () => {
        return cloud.runtimeTask(address.taskId)
      },
      task => task && !task.running && ['completed', 'done', 'idle'].includes(task.status),
      `${caseId}: task did not complete`
    )
    return { address, result }
  }

  async function runDesktopTask(control, runtime, caseId, address, remote = false) {
    currentCase = caseId
    if (!address) {
      if (remote && !remoteProjectReady) {
        const workspace = join(resultDir, 'claude-remote-workspace')
        await mkdir(workspace, { recursive: true })
        await createRemoteProject(control, workspace, workbenchReadyTimeoutMs, captureScreenshot)
        remoteProjectReady = true
      } else if (remote) {
        await control.command('clickDescendantInElementWithText', '[data-testid^="project-row-"]', {
          text: 'claude-remote-workspace',
          target: '[data-testid="project-new-conversation-button"]',
        })
      } else {
        await control.command('click', '[data-testid="new-chat-button"]')
      }
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { visible: true })
      await control.command(
        'click',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-harness-selector"]`
      )
      await control.command(
        'clickWhenEnabled',
        `[data-testid="workbench-harness-option-${runtime}"]`,
        { timeoutMs: workbenchReadyTimeoutMs }
      )
      if (runtime === 'codex') {
        await selectE2EModel(
          control,
          CLOUD_PUBLIC_MODEL_NAME,
          'desktop-e2e-public-upstream-model',
          ACTIVE_WORKBENCH_SELECTOR
        )
      } else {
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workbench-harness-model-selector"]`
        )
        await control.command(
          'clickDescendantInElementWithText',
          '[data-testid^="workbench-harness-model-option-claude_code-"]',
          { text: 'Desktop E2E DeepSeek Pro Vision Main', target: 'span', visible: true }
        )
      }
    }
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: `TASK_TOKEN_CASE:${caseId}` })
    await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
    const result = await wait(
      () => results.get(caseId),
      Boolean,
      `${caseId}: plugin MCP was never called`
    )
    await wait(
      async () => JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')),
      snapshot =>
        currentRuntimeTaskFromDebugSnapshot(snapshot)?.taskId === result.identity.task.id &&
        snapshot.pane?.status?.isBusy === false,
      `${caseId}: desktop task did not complete`
    )
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: `TaskToken verification complete: ${caseId}`,
    })
    if (serviceError) throw serviceError
    const current = currentRuntimeTaskFromDebugSnapshot(
      JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    )
    assert.equal(result.identity.task.id, current.taskId)
    if (remote) {
      assert.equal(current.deviceId, CLOUD_DEVICE_ID)
      assert.equal(result.identity.task.device_id, CLOUD_DEVICE_ID)
    }
    if (address) assert.equal(current.taskId, address.taskId)
    return { address: current, result }
  }

  return {
    requiresCloudEnvironment: true,
    claudeBinary,
    appEnvironment: { CLAUDE_BINARY_PATH: claudeBinary },
    setCloudEnvironment(environment) {
      cloud = environment
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const callId = `task-token-${currentCase}`
      modelRequests.push({
        caseId: currentCase,
        model: body.model,
        tools: body.tools?.map(tool => ({
          type: tool.type,
          name: tool.name ?? tool.function?.name,
        })),
        discovered: requestToolSearchResults(body),
      })
      await writeFile(
        join(resultDir, 'task-token-model-tools.json'),
        JSON.stringify(modelRequests, null, 2)
      )
      let events
      if (!currentCase || !JSON.stringify(body.input).includes('TASK_TOKEN_CASE:')) {
        events = textEvents(callId, 'TaskToken fixture ready')
      } else if (requestContainsToolOutput(body, callId)) {
        events = textEvents(callId, `TaskToken verification complete: ${currentCase}`)
      } else {
        const direct = body.tools?.find(tool =>
          (tool.name ?? tool.function?.name ?? '').endsWith('task_token_probe')
        )
        const namespace = requestToolSearchResults(body).find(item =>
          item.tools?.some(tool => tool.name === 'task_token_probe')
        )
        if (direct) {
          events = functionCall(callId, direct.name ?? direct.function.name, {
            case_id: currentCase,
          })
        } else if (namespace) {
          events = namespacedFunctionCall(callId, namespace.name, 'task_token_probe', {
            case_id: currentCase,
          })
        } else {
          events = toolSearchResponseEvents(
            `${callId}-search`,
            selectToolSearch(body, 'task_token_probe')
          )
        }
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(
        [responseCreated(callId), ...events, responseCompleted(callId)]
          .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join('')
      )
      return true
    },
    async verify(control) {
      await configureClaude(
        control,
        claudeBinary,
        await localHarnessCliVersion(claudeBinary),
        workbenchReadyTimeoutMs
      )
      const local = await cloud.waitForConnectedAppDevice()
      const release = await cloud.publishPluginRelease({
        slug,
        version: '1.0.0',
        packageRoot: root,
      })
      for (const deviceId of [local.device_id, CLOUD_DEVICE_ID]) {
        await api(
          `/plugins/marketplace/${release.pluginId}/install?device_id=${encodeURIComponent(deviceId)}`,
          'POST'
        )
      }
      for (const home of [executorHome, dirname(cloud.remoteCodexHome)]) {
        await wait(
          async () => JSON.parse(await readFile(join(home, 'capabilities/manifest.json'), 'utf8')),
          manifest =>
            Object.values(manifest.plugins ?? {}).some(
              plugin => plugin.name === slug && plugin.enabled
            ),
          'Plugin package did not synchronize'
        )
      }
      for (const [location, deviceId] of [
        ['local', local.device_id],
        ['remote', CLOUD_DEVICE_ID],
      ]) {
        for (const runtime of ['codex', 'claude_code']) {
          const group = `${location}-${runtime}`
          const invoke = (caseId, address) =>
            location === 'local'
              ? runDesktopTask(control, runtime, caseId, address)
              : runtime === 'claude_code'
                ? runDesktopTask(control, runtime, caseId, address, true)
                : runTask(deviceId, runtime, caseId, address)
          const first = await invoke(`${group}-first`)
          console.log(`[task-token] ${group}: first task authenticated`)
          if (location === 'remote') await cloud.restartCloudExecutor()
          const followup = await invoke(`${group}-followup`, first.address)
          if (location === 'local' && runtime === 'codex') {
            await control.command(
              'clickDescendantInElementWithText',
              `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
              {
                target: '[data-testid="fork-message-button"]',
                text: `TaskToken verification complete: ${group}-followup`,
              }
            )
            const forkAddress = await wait(
              async () =>
                currentRuntimeTaskFromDebugSnapshot(
                  JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
                ),
              address => address?.taskId && address.taskId !== first.address.taskId,
              'Native completed-turn fork did not create a new task'
            )
            const forked = await invoke(`${group}-fork`, forkAddress)
            assert.equal(forked.result.allowed, false)
            assert.notEqual(first.result.identity.task.id, forked.result.identity.task.id)
          }
          const other = await invoke(`${group}-other`)
          assert.deepEqual(first.result.identity, followup.result.identity)
          assert.equal(first.result.allowed, true)
          assert.equal(followup.result.allowed, true)
          assert.equal(other.result.allowed, false)
          assert.notEqual(first.result.identity.task.id, other.result.identity.task.id)
          console.log(`[task-token] ${group}: continuation stable; other task denied`)
        }
      }
      for (const path of [
        cloud.backendLogPath,
        cloud.remoteExecutorLogPath,
        join(resultDir, 'executor.log'),
      ]) {
        const content = await readFile(path, 'utf8')
        for (const token of tokens)
          assert.ok(!content.includes(token), 'TaskToken leaked into logs')
      }
      await writeFile(
        join(resultDir, 'plugin-task-token-results.json'),
        JSON.stringify(Object.fromEntries(results), null, 2)
      )
      await captureScreenshot(control, 'plugin-task-token-complete.png')
    },
    async cleanup() {
      service.closeAllConnections()
      await new Promise(resolvePromise => service.close(resolvePromise))
    },
  }
}
