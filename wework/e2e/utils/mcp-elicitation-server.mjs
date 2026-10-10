import { appendFile } from 'node:fs/promises'
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
      await completeElicitation(message.result)
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
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
    pendingToolCalls.set(message.id, true)
    sendUrlElicitation(
      URL_ELICITATION_ID,
      'E2E browser authorization: cancel before explicitly opening'
    )
    return
  }
  respondError(message.id, -32601, `Unknown method: ${String(message.method)}`)
})
