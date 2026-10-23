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
const pendingUrlElicitations = new Map()
const pendingFormElicitations = new Map()
let elicitationSequence = 0

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

function sendElicitation(id) {
  send({
    id,
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

async function completeElicitation(callId, result) {
  await appendFile(
    evidencePath,
    `${JSON.stringify({ event: 'elicitation_result', result })}\n`,
    'utf8'
  )
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

  const urlElicitation = pendingUrlElicitations.get(message.id)
  if (urlElicitation && ('result' in message || 'error' in message)) {
    pendingUrlElicitations.delete(message.id)
    const expected = urlElicitation.step === 'first' ? 'cancel' : 'accept'
    if (message.error || message.result?.action !== expected) {
      throw new Error('The URL authorization regression returned an unexpected action')
    }
    await appendFile(
      evidencePath,
      `${JSON.stringify({ event: 'url_elicitation_result', result: message.result })}\n`,
      'utf8'
    )
    if (urlElicitation.step === 'first' && verifyUrlAccept) {
      const acceptId = `${urlElicitation.urlId}-accept`
      pendingUrlElicitations.set(acceptId, {
        ...urlElicitation,
        step: 'accept',
        urlId: acceptId,
      })
      sendUrlElicitation(acceptId, 'E2E browser authorization: explicitly open to continue')
    } else {
      pendingFormElicitations.set(urlElicitation.formId, urlElicitation.callId)
      sendElicitation(urlElicitation.formId)
    }
    return
  }

  const callId = pendingFormElicitations.get(message.id)
  if (callId && ('result' in message || 'error' in message)) {
    pendingFormElicitations.delete(message.id)
    try {
      if (message.error) throw new Error(JSON.stringify(message.error))
      await completeElicitation(callId, message.result)
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
    elicitationSequence += 1
    const urlId = `wework-e2e-url-elicitation-${elicitationSequence}`
    const formId = `wework-e2e-elicitation-${elicitationSequence}`
    pendingUrlElicitations.set(urlId, { callId: message.id, formId, step: 'first', urlId })
    sendUrlElicitation(urlId, 'E2E browser authorization: cancel before explicitly opening')
    return
  }
  respondError(message.id, -32601, `Unknown method: ${String(message.method)}`)
})
