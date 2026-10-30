import { describe, expect, it } from 'vitest'
import type { RuntimeConversationTurn } from './runtime-conversation'
import type { RequestUserInputResponse } from './runtime'
import {
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
} from './runtime-conversation-turns'

describe('native assistant text identity reconciliation', () => {
  const content = ':codex-file-citation{path="example-only.md"}'
  function turn(id: string, position?: number): RuntimeConversationTurn {
    return {
      id: 'turn-1',
      status: 'done',
      items: [{ id, type: 'assistant_text', content, position }],
    }
  }

  it('replaces provisional text with its positioned native identity in either arrival order', () => {
    const native = turn('native-answer', 1)
    const live = turn('live-answer')
    for (const [local, snapshot] of [[live, native], [native, live]] as const) {
      const merged = mergeRuntimeConversationTurns([local], [snapshot])
      expect(merged[0].items).toEqual(native.items)
      expect(projectRuntimeConversationTurns(merged)[0].content).toBe(content)
    }
  })

  it('preserves equal text at distinct native positions', () => {
    const first = turn('first-answer', 1)
    const second = turn('second-answer', 2)
    const merged = mergeRuntimeConversationTurns([first], [second])
    expect(merged[0].items.map(item => item.id)).toEqual(['first-answer', 'second-answer'])
    expect(projectRuntimeConversationTurns(merged)[0].content).toBe(`${content}\n\n${content}`)
  })

  it('keeps unmatched live output alongside positioned history', () => {
    const local = turn('live-answer')
    local.items.push({ id: 'new-output', type: 'assistant_text', content: 'New output' })
    const merged = mergeRuntimeConversationTurns([local], [turn('native-answer', 1)])
    expect(merged[0].items.map(item => item.id)).toEqual(['native-answer', 'new-output'])
  })
})

function question(requestId: string, response?: RequestUserInputResponse): RuntimeConversationTurn {
  return {
    id: 'turn-1',
    status: 'streaming',
    items: [
      {
        id: 'question',
        type: 'block',
        block: {
          id: 'question',
          type: 'tool',
          toolName: 'request_user_input',
          status: response ? 'done' : 'pending',
          createdAt: 1,
          renderPayload: {
            kind: 'request_user_input',
            requestId,
            questions: [{ id: 'scope', question: 'Scope?' }],
            response,
          },
        },
      },
    ],
  }
}
const accepted = { requestId: 'request-1', answers: { scope: { answers: ['This project'] } } }
function merged(local: RuntimeConversationTurn, snapshot: RuntimeConversationTurn) {
  const item = mergeRuntimeConversationTurns([local], [snapshot])[0].items[0]
  if (item.type !== 'block') throw new Error('Question block missing')
  return item.block
}

describe('runtime question history reconciliation for both hosts', () => {
  it('retains an accepted answer when refreshing a still-streaming turn', () => {
    expect(merged(question('request-1', accepted), question('request-1'))).toMatchObject({
      status: 'done',
      renderPayload: { response: accepted },
    })
  })
  it('keeps the authoritative response when history already records an answer', () => {
    const authoritative = { ...accepted, answers: { scope: { answers: ['All projects'] } } }
    expect(
      merged(question('request-1', accepted), question('request-1', authoritative))
    ).toMatchObject({
      renderPayload: { response: authoritative },
    })
  })
  it('does not carry an answer into a different question reusing the same item', () => {
    expect(merged(question('request-1', accepted), question('request-2'))).toMatchObject({
      status: 'pending',
      renderPayload: { requestId: 'request-2', response: undefined },
    })
  })
  it('does not turn a failed question into a successful answer', () => {
    const snapshot = question('request-1')
    const item = snapshot.items[0]
    if (item.type === 'block') item.block.status = 'error'
    expect(merged(question('request-1', accepted), snapshot)).toMatchObject({ status: 'error' })
  })
})

it('keeps live command output when a transcript read races with a later output event', () => {
  const command = (
    output: string,
    status = 'inProgress',
  ): RuntimeConversationTurn => ({
    id: 'turn-1',
    status: 'done',
    items: [
      {
        id: 'command-1',
        type: 'block',
        block: {
          id: 'command-1',
          type: 'tool',
          toolName: 'bash',
          status: status === 'inProgress' ? 'streaming' : 'done',
          createdAt: 1,
          renderPayload: { kind: 'command_execution', status },
          toolOutput: output,
        },
      },
    ],
  })
  expect(
    merged(command('tick-4\ntick-5\n'), command('tick-4\n')),
  ).toMatchObject({ toolOutput: 'tick-4\ntick-5\n' })
  expect(
    merged(command('tick-4\ntick-5\n'), command('authoritative', 'completed')),
  ).toMatchObject({ toolOutput: 'authoritative', status: 'done' })
})

describe('MCP output history reconciliation', () => {
  function tool(output: unknown): RuntimeConversationTurn {
    return {
      id: 'turn-1',
      status: 'streaming',
      items: [
        {
          id: 'node-repl',
          type: 'block',
          block: {
            id: 'node-repl',
            type: 'tool',
            toolName: 'node_repl.js',
            status: 'done',
            createdAt: 1,
            toolOutput: output,
          },
        },
      ],
    }
  }

  it.each([undefined, null, ''])(
    'keeps a completed MCP result over an empty snapshot (%s)',
    (output) => {
      const result = {
        content: [{ type: 'text', text: "{ status: 'executed', result: 84 }" }],
      }
      expect(merged(tool(result), tool(output))).toMatchObject({
        toolOutput: result,
      })
    },
  )

  it('accepts a nonempty authoritative result', () => {
    expect(merged(tool('live'), tool('history'))).toMatchObject({
      toolOutput: 'history',
    })
  })
})
