import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  DEFAULT_STEP_TIMEOUT_MS,
} from './shared.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const prompt = 'WEWORK_NATIVE_CLOUD_MCP_APP'
const completion = 'NATIVE_CLOUD_APP_COMPLETE'
const callId = 'native-cloud-app-source'

function modelScenario(previous) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return (await previous?.handleHttp?.(request, response, url)) ?? false
      const body = await readRequestBody(request)
      if (!JSON.stringify(body).includes(prompt))
        return (await previous?.handleHttp?.(request, response, url)) ?? false
      if (handleEmptyReplyPrediction(body, response)) return true
      const events = requestContainsToolOutput(body, callId)
        ? [assistantMessage(completion), responseCompleted('native-cloud-app', [])]
        : [
            ...mcpToolRequestEvents(body, {
              toolName: 'show_app',
              argumentsValue: {},
              directToolName: 'mcp__native_cloud_app__show_app',
              searchCallId: `${callId}-search`,
              toolCallId: callId,
            }).events,
            responseCompleted('native-cloud-app'),
          ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated('native-cloud-app'), ...events]))
      return true
    },
  }
}

async function restartAppServer(cloud, deviceId) {
  const { io } = createRequire(
    new URL('../../../../packages/chat-core/package.json', import.meta.url)
  )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
  const socket = io(`${cloud.backendUrl}/wework-runtime`, {
    auth: { token: cloud.authToken },
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    forceNew: true,
  })
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', reject)
      socket.connect()
    })
    const ack = await socket
      .timeout(DEFAULT_STEP_TIMEOUT_MS)
      .emitWithAck('runtime:request', {
        id: crypto.randomUUID(),
        device_id: deviceId,
        method: 'runtime.codex.app_server.restart',
        params: {},
      })
    assert.equal(ack.ok, true, ack.error?.message)
  } finally {
    socket.disconnect()
  }
}

async function waitForValue(read, predicate, message) {
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  do {
    if (predicate(await read())) return
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.fail(message)
}

export async function verifyPositiveMcpCloudOwnership(control, cloud, address, invoke) {
  const configPath = join(cloud.remoteCodexHome, 'config.toml')
  const config = await readFile(configPath, 'utf8')
  const previous = control.desktopScenario
  const scope = `[data-mcp-call-id="${callId}"]`
  const sessionId = crypto.randomUUID()
  const frame = (action, params = {}) =>
    invoke('e2e.mcpAppFrame', { url: 'https://unused.example', action, ...params })
  try {
    await writeFile(
      configPath,
      config +
        `\n[mcp_servers.native_cloud_app]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fileURLToPath(new URL('../../utils/mcp-app-server.mjs', import.meta.url)))}]\n`
    )
    await restartAppServer(cloud, address.deviceId)
    control.setDesktopScenario(modelScenario(previous))
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: prompt })
    await control.command('waitFor', `${ACTIVE_SEND_BUTTON_SELECTOR}:not(:disabled)`)
    await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: completion,
      timeoutMs: 30000,
    })
    await control.command('waitFor', scope + ' [data-testid="mcp-app-frame"][data-ready="true"]')
    const retained = await invoke('mcpApps.retainSession', {
      address,
      callId,
      sessionId,
      windowLabel: 'main',
      target: {
        apiBaseUrl: `${cloud.backendUrl}/api`,
        socketBaseUrl: cloud.backendUrl,
        socketPath: '/socket.io',
      },
    })
    assert.equal(retained.ok, true, retained.error?.message)
    assert.ok((await frame('sessions')).result.includes(sessionId))
    await frame('disconnect-session', { sessionId })
    await waitForValue(
      () => readFile(cloud.remoteExecutorLogPath, 'utf8'),
      value =>
        value
          .split('\n')
          .some(
            line =>
              line.includes('codex MCP App session released') &&
              line.includes(`app_session_id=${sessionId}`)
          ),
      'Backend disconnect must release the exact remote instance'
    )
    assert.equal((await invoke('mcpApps.releaseSession', { sessionId })).ok, true)
    const url = await control.command('getAttribute', scope + ' [data-testid="mcp-app-frame"]', {
      value: 'src',
    })
    assert.equal((await frame('click', { url, selector: '#refresh' })).ok, true)
    await waitForValue(
      async () => (await frame('text', { url, selector: '#status' })).result,
      value => value === 'Counter 1',
      'Another cloud instance must remain usable after owner disconnect'
    )
    await control.command('click', scope + ' [data-testid="mcp-app-close"]')
    await waitForValue(
      async () => (await frame('sessions')).result,
      value => value.length === 0,
      'Closing the cloud app must release native ownership'
    )
  } finally {
    control.setDesktopScenario(previous)
    await invoke('mcpApps.releaseSession', { sessionId })
    await writeFile(configPath, config)
    await restartAppServer(cloud, address.deviceId)
  }
}
