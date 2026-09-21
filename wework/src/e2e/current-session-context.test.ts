import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, test } from 'vitest'

let currentSessionContext: (body: unknown) => Record<string, unknown>

beforeAll(async () => {
  const scenarioUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/scenarios/context-compaction.scenario.mjs')
  ).href
  const scenario = await import(/* @vite-ignore */ scenarioUrl)
  currentSessionContext = scenario.currentSessionContext
})

function session(messageId: string) {
  const encode = (parts: string[]) => Buffer.from(JSON.stringify(parts)).toString('base64url')
  return {
    conversation_id: `conv_${encode(['device-1', 'task-1'])}`,
    response_id: `resp_${encode(['device-1', 'task-1', messageId])}`,
    execution: { type: 'wework', device_id: 'device-1' },
    model_name: 'local-model',
    model: null,
    api_conversation_supported: true,
  }
}

function contextText(value: unknown) {
  // Codex puts the closing context tag directly after the compact JSON payload.
  return `<wework.session.current>Current Wework HTTP API IDs.\n${JSON.stringify(value)}</wework.session.current>`
}

function request(...texts: string[]) {
  return {
    input: texts.map(text => ({
      role: 'user',
      content: [{ type: 'input_text', text }],
    })),
  }
}

describe('currentSessionContext', () => {
  test('parses the Codex context envelope without including its closing tag', () => {
    const expected = session('message-1')
    const body = request(
      `${contextText(expected)}\n<other.context>\n{"conversation_id":"unrelated"}</other.context>`
    )

    expect(currentSessionContext(body)).toEqual(expected)
  })

  test('reads the latest context when earlier turns remain in the input', () => {
    const first = session('message-1')
    const latest = session('message-2')

    expect(currentSessionContext(request(contextText(first), contextText(latest)))).toEqual(latest)
  })

  test('rejects missing context instead of reading unrelated JSON', () => {
    expect(() => currentSessionContext(request(JSON.stringify(session('message-1'))))).toThrow(
      'The model request did not receive current session context'
    )
  })

  test('rejects malformed current context instead of accepting an older turn', () => {
    expect(() =>
      currentSessionContext(
        request(
          contextText(session('message-1')),
          '<wework.session.current>Current Wework HTTP API IDs.\n{invalid}</wework.session.current>'
        )
      )
    ).toThrow(SyntaxError)
  })
})
