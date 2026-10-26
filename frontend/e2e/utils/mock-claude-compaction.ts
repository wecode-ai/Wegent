import type { IncomingMessage, ServerResponse } from 'http'
import { writeAnthropicJsonResponse, writeAnthropicStreamingResponse } from './mock-anthropic'

type MessageRequest = {
  model?: string
  messages?: Array<{ role: string; content: unknown }>
  max_tokens?: number
  stream?: boolean
}

type Scenario = {
  model: string
  mode: 'proactive' | 'overflow-400' | 'overflow-460' | 'unrelated-error'
  requests: Array<{ kind: string; body: MessageRequest }>
}

const scenarios = new Map<string, Scenario>()

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function respond(
  res: ServerResponse,
  request: MessageRequest,
  content: string,
  cachedTokens = 0
): void {
  const usage = { input_tokens: 100, cache_read_input_tokens: cachedTokens }
  const model = request.model || 'mock-claude'
  if (request.stream) {
    writeAnthropicStreamingResponse(res, content, model, 0, 0, usage)
  } else {
    writeAnthropicJsonResponse(res, content, model, usage)
  }
}

/** Model-only fixtures; Claude Code, both proxies, and task transport remain real. */
export function handleClaudeCompactionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: string
): boolean {
  const url = new URL(req.url || '/', 'http://mock-model')
  if (url.pathname === '/claude-compaction-scenarios') {
    if (req.method === 'POST') {
      const input = JSON.parse(rawBody) as Pick<Scenario, 'model' | 'mode'>
      if (
        !input.model ||
        !['proactive', 'overflow-400', 'overflow-460', 'unrelated-error'].includes(input.mode)
      ) {
        json(res, 400, { error: 'A model and compaction mode are required' })
        return true
      }
      scenarios.set(input.model, { ...input, requests: [] })
      json(res, 200, { configured: true })
    } else if (req.method === 'DELETE') {
      scenarios.delete(url.searchParams.get('model') || '')
      json(res, 200, { deleted: true })
    } else {
      const scenario = scenarios.get(url.searchParams.get('model') || '')
      json(res, scenario ? 200 : 404, scenario || { error: 'Scenario not found' })
    }
    return true
  }
  if (!url.pathname.endsWith('/messages') || req.method !== 'POST') return false
  const body = JSON.parse(rawBody) as MessageRequest
  const model = body.model?.replace(/(?:\[1m\]|\+1m)$/i, '') || ''
  const scenario = scenarios.get(model)
  if (!scenario) return false

  const latestUser = body.messages?.filter(message => message.role === 'user').at(-1)
  const compact =
    /CRITICAL: Respond with TEXT ONLY|create a detailed summary of the conversation/i.test(
      JSON.stringify(latestUser?.content)
    )
  const seedCount = scenario.requests.filter(request => request.kind === 'seed').length
  const seeded = seedCount >= 2
  const recovered = scenario.requests.some(request => request.kind === 'compact')
  const kind = compact ? 'compact' : !seeded ? 'seed' : recovered ? 'complete' : 'overflow'
  scenario.requests.push({ kind, body })

  if (compact) {
    respond(
      res,
      body,
      `COMPACT_SUMMARY_${model}: Remember the original seed and finish the follow-up.`
    )
  } else if (!seeded) {
    const cachedTokens =
      seedCount === 0 ? 400_000 : scenario.mode === 'proactive' ? 850_000 : 600_000
    respond(res, body, `SEED_OK_${seedCount + 1}_${model}`, cachedTokens)
  } else if (scenario.mode === 'unrelated-error') {
    json(res, 400, {
      error: {
        type: 'invalid_request_error',
        message: `UNRELATED_ERROR_${model}: invalid parameter`,
      },
    })
  } else if (!recovered && scenario.mode !== 'proactive') {
    const status = scenario.mode === 'overflow-460' ? 460 : 400
    json(res, status, {
      error: {
        code: 'InvalidParameter',
        message:
          status === 460
            ? '对话内容太长，已超出当前模型的处理能力。'
            : 'Input exceeds the context limit (1048568 tokens).',
      },
    })
  } else {
    respond(res, body, `COMPLETE_OK_${model}`)
  }
  return true
}
