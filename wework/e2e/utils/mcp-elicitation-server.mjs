import { appendFile, access } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import readline from 'node:readline'

const evidencePath = process.argv[2]
// The protocol unit test exercises both actions without launching a browser.
// Desktop CI currently owns cancellation; acceptance needs a real system browser.
const verifyUrlAccept = process.argv.includes('--verify-url-accept')
if (!evidencePath) {
  throw new Error('Usage: mcp-elicitation-server.mjs <evidence-path>')
}

const TOOL_NAME = 'confirm_inner_site_access'
const ELICITATION_ID = 'wework-e2e-elicitation-1'
const URL_ELICITATION_ID = 'wework-e2e-url-elicitation-1'
const URL_ACCEPT_ELICITATION_ID = 'wework-e2e-url-elicitation-2'
const pendingToolCalls = new Map()
const scenarios = [
  'url_timeout',
  'form_timeout',
  'concurrent_accept',
  'concurrent_cancel',
  'concurrent_timeout',
  'concurrent_ordinary_first',
]

function scenarioEvidencePath(scenario) {
  return scenario?.startsWith('concurrent_') ? `${evidencePath}.concurrent` : evidencePath
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function respond(id, result) {
  send({ id, result })
}

function respondError(id, code, message) {
  send({ id, error: { code, message } })
}

function sendUrlElicitation(id, message) {
  send({
    id,
    method: 'elicitation/create',
    params: {
      mode: 'url',
      elicitationId: id,
      url: 'https://example.com/wework-e2e-authorization',
      message,
    },
  })
}

function sendElicitation() {
  send({
    id: ELICITATION_ID,
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: '请选择内网访问范围',
      requestedSchema: {
        type: 'object',
        properties: {
          audience: {
            type: 'string',
            title: '访问范围',
            description: '请选择站点发布到内网后的访问范围。',
            enum: ['all', 'owner'],
            enumNames: ['所有人', '仅自己'],
          },
        },
        required: ['audience'],
      },
    },
  })
}

async function completeElicitation(result) {
  await appendFile(
    evidencePath,
    `${JSON.stringify({ event: 'elicitation_result', result })}\n`,
    'utf8'
  )
  for (const [callId] of pendingToolCalls) {
    pendingToolCalls.delete(callId)
    const audience = result?.content?.audience
    const accepted = result?.action === 'accept' && audience === 'owner'
    respond(callId, {
      content: [
        {
          type: 'text',
          text: accepted
            ? 'E2E_MCP_ELICITATION_ACCEPTED:owner'
            : `E2E_MCP_ELICITATION_REJECTED:${String(result?.action ?? 'unknown')}`,
        },
      ],
      structuredContent: accepted
        ? { audience, marker: 'E2E_MCP_ELICITATION_ACCEPTED:owner' }
        : { action: result?.action ?? 'unknown' },
      isError: !accepted,
    })
  }
}

async function completeTimeoutElicitation(result) {
  for (const [callId, pending] of pendingToolCalls) {
    if (!pending.scenario) continue
    await appendFile(
      scenarioEvidencePath(pending.scenario),
      `${JSON.stringify({
        event: pending.scenario.startsWith('concurrent_')
          ? 'concurrent_elicitation_result'
          : 'timeout_elicitation_result',
        scenario: pending.scenario,
        // Match the executor's monotonic timeout clock; wall time can be corrected by NTP.
        elapsedMs: performance.now() - pending.startedMonotonic,
        wallElapsedMs: Date.now() - pending.startedAt,
        result,
      })}\n`,
      'utf8'
    )
    pendingToolCalls.delete(callId)
    const prefix = pending.scenario.startsWith('concurrent_') ? 'CONCURRENT' : 'TIMEOUT'
    const marker = `E2E_MCP_ELICITATION_${prefix}:${pending.scenario}:${result?.action}`
    respond(callId, {
      content: [{ type: 'text', text: marker }],
      structuredContent: { marker, action: result?.action },
      isError: false,
    })
  }
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

input.on('line', async line => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch (error) {
    console.error(`[mcp-elicitation] Ignoring malformed JSON: ${String(error)}`)
    return
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return

  if (
    [URL_ELICITATION_ID, URL_ACCEPT_ELICITATION_ID].includes(message.id) &&
    ('result' in message || 'error' in message)
  ) {
    if ([...pendingToolCalls.values()].some(pending => pending.scenario === 'url_timeout')) {
      if (message.error) throw new Error('URL timeout returned a protocol error instead of cancel')
      await completeTimeoutElicitation(message.result)
      return
    }
    const expected = message.id === URL_ELICITATION_ID ? 'cancel' : 'accept'
    if (message.error || message.result?.action !== expected) {
      throw new Error('The URL authorization regression returned an unexpected action')
    }
    await appendFile(
      evidencePath,
      `${JSON.stringify({ event: 'url_elicitation_result', result: message.result })}\n`,
      'utf8'
    )
    if (expected === 'cancel' && verifyUrlAccept) {
      sendUrlElicitation(
        URL_ACCEPT_ELICITATION_ID,
        'E2E browser authorization: explicitly open to continue'
      )
    } else {
      sendElicitation()
    }
    return
  }

  if (message.id === ELICITATION_ID && ('result' in message || 'error' in message)) {
    try {
      if (message.error) throw new Error(JSON.stringify(message.error))
      if ([...pendingToolCalls.values()].some(pending => pending.scenario)) {
        await completeTimeoutElicitation(message.result)
      } else {
        await completeElicitation(message.result)
      }
    } catch (error) {
      console.error(`[mcp-elicitation] Failed to complete elicitation: ${String(error)}`)
      process.exitCode = 1
    }
    return
  }
  if (!('id' in message)) return

  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'wework-e2e-mcp-elicitation', version: '1.0.0' },
    })
    return
  }
  if (message.method === 'tools/list') {
    respond(message.id, {
      tools: [
        {
          name: TOOL_NAME,
          description: 'Ask the user to confirm the inner-site access audience.',
          inputSchema: {
            type: 'object',
            properties: { scenario: { type: 'string', enum: scenarios } },
            additionalProperties: false,
          },
        },
      ],
    })
    return
  }
  if (message.method === 'tools/call') {
    if (message.params?.name !== TOOL_NAME) {
      respondError(message.id, -32601, `Unknown tool: ${String(message.params?.name)}`)
      return
    }
    const scenario = message.params?.arguments?.scenario
    if (scenario !== undefined && !scenarios.includes(scenario)) {
      respondError(message.id, -32602, 'Unknown elicitation scenario')
      return
    }
    if (scenario?.startsWith('concurrent_')) {
      // Keep a real tools/call pending while Code Mode yields. The desktop opens
      // this gate after the ordinary question is visible, or before releasing
      // that model response when testing the reverse card/answer order.
      const gate = `${scenarioEvidencePath(scenario)}.${scenario}.ready`
      const deadline = performance.now() + 30_000
      while (true) {
        try {
          await access(gate)
          break
        } catch (error) {
          if (error.code !== 'ENOENT' || performance.now() >= deadline) throw error
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
    }
    const startedAt = Date.now()
    const startedMonotonic = performance.now()
    pendingToolCalls.set(message.id, { scenario, startedAt, startedMonotonic })
    if (scenario) {
      await appendFile(
        scenarioEvidencePath(scenario),
        `${JSON.stringify({ event: scenario.startsWith('concurrent_') ? 'concurrent_elicitation_request' : 'timeout_elicitation_request', scenario, startedAt })}\n`,
        'utf8'
      )
    }
    if (scenario && scenario !== 'url_timeout') {
      sendElicitation()
      return
    }
    sendUrlElicitation(
      URL_ELICITATION_ID,
      scenario === 'url_timeout'
        ? 'E2E browser authorization: wait for the ten-minute deadline'
        : 'E2E browser authorization: cancel before explicitly opening'
    )
    return
  }
  respondError(message.id, -32601, `Unknown method: ${String(message.method)}`)
})
