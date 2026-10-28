import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { isReplyPredictionRequest } from '../modules/response-protocol.mjs'
import {
  currentExecutorPid,
  waitForRestartedExecutor,
} from '../modules/executor-restart-readiness.mjs'
import {
  WORKBENCH_READY_TIMEOUT_MS,
  createSingleRootLocalProject,
  fetchJson,
  selectE2EModel,
  waitForLogPattern,
} from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const ASSISTANT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
const PROMPT = 'WEWORK_DESKTOP_E2E_CODEX_INVALID_LAUNCH_CWD'
const COMPLETION = 'WEWORK_DESKTOP_E2E_CODEX_INVALID_LAUNCH_CWD_COMPLETE'
const BUILTIN_MODEL_ID = 'gpt-5.5'
const BUILTIN_MODEL_LABEL = 'GPT-5.5'
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function responseEvents(responseId, text = COMPLETION) {
  const itemId = `${responseId}-message`
  return [
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
        phase: 'final_answer',
      },
    },
    {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
        phase: 'final_answer',
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ]
}

function warmupResponseEvents(responseId) {
  return [
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ]
}

function websocketFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const headerBytes = body.length < 126 ? 2 : body.length <= 0xffff ? 4 : 10
  const frame = Buffer.allocUnsafe(headerBytes + body.length)
  frame[0] = 0x80 | opcode
  if (headerBytes === 2) {
    frame[1] = body.length
  } else if (headerBytes === 4) {
    frame[1] = 126
    frame.writeUInt16BE(body.length, 2)
  } else {
    frame[1] = 127
    frame.writeBigUInt64BE(BigInt(body.length), 2)
  }
  body.copy(frame, headerBytes)
  return frame
}

function consumeWebSocketFrames(socket, initialData, onMessage) {
  let buffered = initialData
  let fragments = []
  let fragmentOpcode = null

  const consume = chunk => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 2) {
      const first = buffered[0]
      const second = buffered[1]
      const opcode = first & 0x0f
      const final = (first & 0x80) !== 0
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffered.length < 4) return
        length = buffered.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffered.length < 10) return
        length = Number(buffered.readBigUInt64BE(2))
        offset = 10
      }
      assert.equal(masked, true, 'The Codex WebSocket client sent an unmasked frame')
      if (buffered.length < offset + 4 + length) return
      const mask = buffered.subarray(offset, offset + 4)
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length))
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4]
      }
      buffered = buffered.subarray(offset + 4 + length)

      if (opcode === 0x8) {
        socket.end(websocketFrame(payload, 0x8))
        return
      }
      if (opcode === 0x9) {
        socket.write(websocketFrame(payload, 0x0a))
        continue
      }
      if (opcode === 0x1) {
        fragmentOpcode = opcode
        fragments = [payload]
      } else if (opcode === 0x0 && fragmentOpcode !== null) {
        fragments.push(payload)
      } else {
        continue
      }
      if (final) {
        onMessage(Buffer.concat(fragments).toString('utf8'))
        fragments = []
        fragmentOpcode = null
      }
    }
  }

  socket.on('data', consume)
  if (initialData.length) consume(Buffer.alloc(0))
}

function acceptWebSocket(request, socket, head, onMessage) {
  const key = request.headers['sec-websocket-key']
  assert.equal(typeof key, 'string', 'The Codex WebSocket handshake omitted its key')
  const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64')
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n')
  )
  consumeWebSocketFrames(socket, head, onMessage)
}

export function attachCodexModelWebSocket(
  server,
  { modelServerUrl, onForegroundRequest, isVerificationComplete }
) {
  const sockets = new Set()
  let closing = false
  server.on('upgrade', (request, socket, head) => {
    let auxiliaryRequest = false
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', error => {
      const peerDisconnected = ['ECONNRESET', 'EPIPE'].includes(error.code)
      // Composer predictions and warmups may be cancelled while the model is writing.
      // Foreground transport errors must still fail the checkpoint.
      if (!(peerDisconnected && (auxiliaryRequest || closing || isVerificationComplete()))) {
        server.emit('error', error)
      }
      socket.destroy()
    })
    const url = new URL(request.url ?? '/', modelServerUrl)
    if (!['/v1/responses', '/responses'].includes(url.pathname)) {
      socket.destroy()
      return
    }
    acceptWebSocket(request, socket, head, message => {
      const body = JSON.parse(message)
      if (body.type !== 'response.create') return

      const responseId = `wework-invalid-cwd-${Date.now()}`
      const isWarmup = body.generate === false
      const isPrediction = isReplyPredictionRequest(body)
      auxiliaryRequest = isWarmup || isPrediction
      if (!auxiliaryRequest) onForegroundRequest(body)
      const events = isWarmup
        ? warmupResponseEvents(responseId)
        : responseEvents(
            responseId,
            isPrediction ? JSON.stringify({ suggestion: null }) : COMPLETION
          )
      if (!socket.destroyed) {
        socket.write(Buffer.concat(events.map(event => websocketFrame(JSON.stringify(event)))))
      }
    })
  })
  return () => {
    closing = true
    for (const socket of sockets) socket.destroy()
    sockets.clear()
  }
}

async function restartExecutorAfterRemovingCwd(
  control,
  executorLogPath,
  launchWorkingDirectory,
  timeoutMs
) {
  const originalPid = await currentExecutorPid(control)
  assert.ok(originalPid, 'The initial executor process was not running')
  const logOffset = (await readFile(executorLogPath, 'utf8').catch(() => '')).length

  await rm(launchWorkingDirectory, { recursive: true })
  process.kill(originalPid, 'SIGTERM')

  return waitForRestartedExecutor({
    control,
    originalPid,
    executorLogPath,
    logOffset,
    timeoutMs,
  })
}

export function createDesktopScenario({
  captureScreenshot,
  resultDir,
  uiTimeoutMs,
  workspacePath,
}) {
  let requestCount = 0
  let verificationComplete = false
  let closeModelSockets
  const executorLogPath = join(resultDir, 'executor.log')
  const launchWorkingDirectory = join(resultDir, 'invalid-launch-cwd')
  const modelServerPort = process.env.WEWORK_E2E_MODEL_SERVER_PORT
  assert.match(
    modelServerPort ?? '',
    /^\d+$/,
    'The built-in OpenAI provider scenario requires the reserved model server port'
  )
  const modelServerUrl = `http://127.0.0.1:${modelServerPort}`
  let configPath
  const configStates = []
  let loadedConfigState
  const captureConfigState = async phase => {
    const content = await readFile(configPath, 'utf8')
    const state = {
      phase,
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
      expectedModelPresent: content.includes(`model = "${BUILTIN_MODEL_ID}"`),
      expectedBaseUrlPresent: content.includes(`openai_base_url = "${modelServerUrl}/v1"`),
    }
    configStates.push(state)
    console.log(`[desktop-e2e] invalid-cwd config state: ${JSON.stringify(state)}`)
  }

  return {
    async prepareApp({ codexHome }) {
      configPath = join(codexHome, 'config.toml')
      await captureConfigState('before-launch')
    },
    attachServer(server) {
      closeModelSockets = attachCodexModelWebSocket(server, {
        modelServerUrl,
        isVerificationComplete: () => verificationComplete,
        onForegroundRequest(body) {
          assert.match(
            JSON.stringify(body),
            new RegExp(PROMPT),
            'The built-in OpenAI request did not contain the submitted prompt'
          )
          requestCount += 1
        },
      })
    },
    codexConfigToml: `openai_base_url = "${modelServerUrl}/v1"`,
    launchWorkingDirectory,
    modelProviderId: 'openai',
    modelId: BUILTIN_MODEL_ID,
    modelServerUrl,
    close() {
      closeModelSockets?.()
    },

    async verify(control) {
      await captureConfigState('before-executor-restart')
      if (process.platform !== 'win32') {
        await restartExecutorAfterRemovingCwd(
          control,
          executorLogPath,
          launchWorkingDirectory,
          uiTimeoutMs
        )
      }
      await captureConfigState('after-executor-restart')
      // Project creation refreshes Codex threads, so first await cold-start catalog readiness.
      const modelCatalogLogOffset = (await readFile(executorLogPath, 'utf8')).length
      await control.command('dispatchLocalModelSettingsChanged', '')
      await waitForLogPattern(
        executorLogPath,
        /app IPC request started request_id=(\S+) method=runtime\.codex\.models\.list[\s\S]*?app IPC request finished request_id=\1 method=runtime\.codex\.models\.list[^\n]*ok=true/,
        { fromOffset: modelCatalogLogOffset, timeoutMs: WORKBENCH_READY_TIMEOUT_MS }
      )
      await createSingleRootLocalProject(control, workspacePath, 'codex-invalid-launch-cwd')
      await selectE2EModel(control, BUILTIN_MODEL_ID, BUILTIN_MODEL_LABEL, '', 'openai')
      await captureConfigState('before-send')
      const origin = await control.command('getLocationOrigin', 'body')
      const response = await fetchJson(`${origin}/wework/executor/v1/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'invalid-cwd-config-diagnostics',
          method: 'runtime.codex.app_server.request',
          params: { method: 'config/read', params: { includeLayers: true, cwd: null } },
        }),
      })
      assert.equal(response.ok, true, 'The restarted Codex could not read its configuration')
      loadedConfigState = {
        expectedModelPresent: response.result.config.model === BUILTIN_MODEL_ID,
        layers: response.result.layers?.map(layer => ({
          type: layer.name.type,
          file: layer.name.file,
          disabled: Boolean(layer.disabledReason),
          modelPresent: typeof layer.config?.model === 'string',
          openaiBaseUrlPresent: typeof layer.config?.openai_base_url === 'string',
        })),
      }
      console.log(`[desktop-e2e] invalid-cwd loaded config: ${JSON.stringify(loadedConfigState)}`)
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', ASSISTANT_SELECTOR, {
        text: COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      assert.equal(
        requestCount,
        1,
        'Codex did not complete exactly one built-in provider turn after cwd removal'
      )
      const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
      assert.equal(
        snapshot.testIds.includes('assistant-error-card'),
        false,
        'Codex rendered a configuration error for the built-in provider after its inherited cwd was removed'
      )
      await captureScreenshot(
        control,
        'codex-invalid-launch-cwd-01-completed.png',
        ACTIVE_WORKBENCH_SELECTOR
      )
      verificationComplete = true
    },

    diagnostics() {
      return { requestCount, configStates, loadedConfigState }
    },
  }
}
