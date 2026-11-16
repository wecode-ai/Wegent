import { MockScopeStore } from './mock-scope'
import type { IncomingMessage, ServerResponse } from 'http'
import { writeAnthropicJsonResponse, writeAnthropicStreamingResponse } from './mock-anthropic'
import {
  writeAnthropicJsonToolCalls,
  writeAnthropicStreamingToolCalls,
  type ToolCallRule,
} from './mock-anthropic-tools'

type MessageRequest = {
  model?: string
  stream?: boolean
  messages?: Array<{ role: string; content: unknown }>
  tools?: Array<{ name: string; input_schema?: { properties?: Record<string, unknown> } }>
}

type Scenario = {
  model: string
  mode: 'complete' | 'stop' | 'large-output'
  subagentType?: string
  parentCalls: number
  childCalls: number
  childFinished: boolean
  parentYielded: boolean
  completionReceived: boolean
  requests: Array<{ kind: string; timestamp: number; body: MessageRequest }>
}

const scenarios = new MockScopeStore(() => new Map<string, Scenario>())
const pendingChildren = new MockScopeStore(() => new Map<string, () => void>())
const LARGE_CHILD_BYTES = 1100 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block.type === 'text')
    .map(block => String(block.text))
    .join('\n')
}

function text(res: ServerResponse, body: MessageRequest, content: string): void {
  if (body.stream) writeAnthropicStreamingResponse(res, content, body.model!, 0, 0)
  else writeAnthropicJsonResponse(res, content, body.model!)
}

function tools(res: ServerResponse, body: MessageRequest, calls: ToolCallRule[]): void {
  for (const call of calls) {
    if (!body.tools?.some(tool => tool.name === call.toolName)) {
      throw new Error(`Claude did not offer ${call.toolName}`)
    }
  }
  if (body.stream) writeAnthropicStreamingToolCalls(res, body, body.model!, calls)
  else writeAnthropicJsonToolCalls(res, body, body.model!, calls)
}

function startChildWork(res: ServerResponse, body: MessageRequest): void {
  tools(res, body, [
    {
      toolName: 'Bash',
      arguments: {
        command: `sleep 2; printf 'BG_WAIT=%s REPORT=%s CHILD_PROBE_OK' "$CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS" "$CLAUDE_CODE_BG_TASKS_REPORT_RUNNING"`,
        description: 'Finish the real background worker after the inherited wait ceiling',
      },
    },
  ])
}

function hasCompletedChildNotification(body: MessageRequest, childMarker: string): boolean {
  const agentId = JSON.stringify(body.messages).match(/agentId:\s*([\w-]+)/)?.[1]
  if (!agentId) return false
  for (const message of body.messages || []) {
    if (message.role !== 'user') continue
    const notifications = userText(message.content).matchAll(
      /<task-notification>[\s\S]*?<\/task-notification>/g
    )
    for (const [notification] of notifications) {
      const taskId = notification.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim()
      if (
        taskId === agentId &&
        notification.includes('<status>completed</status>') &&
        notification.includes(childMarker)
      ) {
        return true
      }
    }
  }
  return false
}

function respondLargeOutput(
  res: ServerResponse,
  body: MessageRequest,
  scenario: Scenario,
  child: boolean
): void {
  const childMarker = `BG_LARGE_CHILD_${scenario.model}`
  const children = pendingChildren.current()
  if (child) {
    const finishChild = () => {
      scenario.childFinished = true
      // One delta exercises the real CLI's large JSON message without many timers.
      text(res, body, `${childMarker}${'x'.repeat(LARGE_CHILD_BYTES)}${childMarker}_END`)
    }
    if (scenario.parentYielded) finishChild()
    else {
      // Keep the child pending until the parent's early end_turn has been sent.
      children.set(scenario.model, finishChild)
      res.once('close', () => children.delete(scenario.model))
    }
  } else if (scenario.parentCalls === 1) {
    const agent = body.tools?.find(tool => tool.name === 'Agent')
    if (!agent?.input_schema?.properties?.run_in_background) {
      throw new Error('Real Claude Agent did not offer background execution')
    }
    tools(res, body, [
      {
        toolName: 'Agent',
        arguments: {
          description: 'Large stdout regression worker',
          subagent_type: 'general-purpose',
          prompt: `BG_WORKER_${scenario.model}`,
          run_in_background: true,
        },
      },
    ])
  } else if (scenario.parentCalls === 2) {
    res.once('finish', () => {
      scenario.parentYielded = true
      const pendingChild = children.get(scenario.model)
      children.delete(scenario.model)
      pendingChild?.()
    })
    text(res, body, `BG_LARGE_PARENT_WAITING_${scenario.model}`)
  } else {
    scenario.completionReceived = hasCompletedChildNotification(body, childMarker)
    if (!scenario.completionReceived) {
      throw new Error('Real background completion notification was not received')
    }
    text(res, body, `BG_LARGE_PARENT_DONE_${scenario.model}`)
  }
}

function respond(res: ServerResponse, body: MessageRequest, scenario: Scenario): void {
  const workerPrompt = `BG_WORKER_${scenario.model}`
  const child = body.messages?.some(
    message => message.role === 'user' && userText(message.content).includes(workerPrompt)
  )
  const kind = child ? `child-${scenario.childCalls++}` : `parent-${scenario.parentCalls++}`
  scenario.requests.push({ kind, timestamp: Date.now(), body })
  if (scenario.mode === 'large-output') return respondLargeOutput(res, body, scenario, !!child)
  if (child) {
    // Keep a real child model request pending until the parent stops its agent.
    if (scenario.mode === 'stop') return
    if (scenario.childCalls === 1) {
      // Start the real two-second command only after the parent's early end_turn.
      if (scenario.parentCalls < 2) {
        pendingChildren.current().set(scenario.model, () => startChildWork(res, body))
        res.on('close', () => pendingChildren.current().delete(scenario.model))
      } else startChildWork(res, body)
    } else {
      scenario.childFinished = true
      text(res, body, `BG_CHILD_DONE_${scenario.model}`)
    }
    return
  }
  if (scenario.parentCalls === 1) {
    const agent = body.tools?.find(tool => tool.name === 'Agent')
    const args: Record<string, unknown> = {
      description: 'Background lifecycle regression worker',
      subagent_type: scenario.subagentType ?? 'general-purpose',
      prompt: workerPrompt,
    }
    if (agent?.input_schema?.properties?.run_in_background) args.run_in_background = true
    tools(res, body, [{ toolName: 'Agent', arguments: args }])
  } else if (scenario.mode === 'stop' && scenario.parentCalls === 2) {
    tools(res, body, [{ toolName: 'ToolSearch', arguments: { query: 'select:TaskStop' } }])
  } else if (scenario.mode === 'stop' && scenario.parentCalls === 3) {
    const agentId = JSON.stringify(body.messages).match(/agentId:\s*([\w-]+)/)?.[1]
    if (!agentId) throw new Error('Real Claude Agent result did not contain an agentId')
    tools(res, body, [{ toolName: 'TaskStop', arguments: { task_id: agentId } }])
  } else if (scenario.mode === 'stop') {
    text(res, body, `BG_PARENT_CLAIMS_COMPLETE_${scenario.model}`)
  } else {
    text(
      res,
      body,
      scenario.childFinished
        ? `BG_PARENT_DONE_${scenario.model}`
        : `BG_PARENT_WAITING_${scenario.model}`
    )
    const pendingChild = pendingChildren.current().get(scenario.model)
    pendingChildren.current().delete(scenario.model)
    pendingChild?.()
  }
}

/** Only the model is simulated. The Agent, Bash, TaskStop and CLI result are real. */
export function handleClaudeBackgroundRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: string
): boolean {
  const url = new URL(req.url || '/', 'http://mock-model')
  if (url.pathname === '/claude-background-scenarios') {
    if (req.method === 'POST') {
      const input = JSON.parse(rawBody) as Pick<Scenario, 'model' | 'mode' | 'subagentType'>
      if (!input.model || !['complete', 'stop', 'large-output'].includes(input.mode)) {
        json(res, 400, { error: 'A model and background lifecycle mode are required' })
        return true
      }
      scenarios.current().set(input.model, {
        ...input,
        parentCalls: 0,
        childCalls: 0,
        childFinished: false,
        parentYielded: false,
        completionReceived: false,
        requests: [],
      })
      json(res, 200, { configured: true })
    } else if (req.method === 'DELETE') {
      scenarios.current().delete(url.searchParams.get('model') || '')
      pendingChildren.current().delete(url.searchParams.get('model') || '')
      json(res, 200, { deleted: true })
    } else {
      const scenario = scenarios.current().get(url.searchParams.get('model') || '')
      json(res, scenario ? 200 : 404, scenario || { error: 'Scenario not found' })
    }
    return true
  }
  if (!url.pathname.endsWith('/messages') || req.method !== 'POST') return false
  const body = JSON.parse(rawBody) as MessageRequest
  const scenario = scenarios.current().get(body.model || '')
  if (!scenario) return false
  try {
    respond(res, body, scenario)
  } catch (error) {
    json(res, 400, { error: { type: 'invalid_request_error', message: String(error) } })
  }
  return true
}
