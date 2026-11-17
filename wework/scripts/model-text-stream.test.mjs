// @vitest-environment node
import { Readable } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import { modelTextStream } from '../e2e/desktop/modules/model-text-stream.mjs'
import { MODEL_API_KEY } from '../e2e/desktop/modules/shared.mjs'

afterEach(() => vi.useRealTimers())

for (const protocol of ['responses', 'chat', 'anthropic']) {
  test(`workspace selection retains paced text and ${protocol} termination`, async () => {
    vi.useFakeTimers()
    const server = new DesktopE2EServer('/isolated-stream-fixture')
    server.scenario = 'workspace_selection_streaming'
    const message = { role: 'user', content: 'WEWORK_DESKTOP_E2E_WORKSPACE_SELECTION_STREAMING' }
    const body = protocol === 'responses' ? { input: [message] } : { messages: [message] }
    const request = Readable.from([JSON.stringify(body)])
    request.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
    const firstDelta = Promise.withResolvers()
    const writes = []
    let finished = false
    const response = {
      writeHead: status => expect(status).toBe(200),
      write(frame) {
        writes.push(frame)
        if (frame.includes('"delta"')) firstDelta.resolve()
      },
      end(frame) {
        writes.push(frame)
        finished = true
      },
    }
    const completion = server.handleModelResponse(request, response, protocol)
    await firstDelta.promise
    expect(finished).toBe(false)
    const initial = writes.length
    await vi.advanceTimersByTimeAsync(249)
    expect(writes).toHaveLength(initial)
    await vi.advanceTimersByTimeAsync(1)
    expect(writes.length).toBeGreaterThan(initial)
    await vi.runAllTimersAsync()
    await completion
    expect(finished).toBe(true)
    const data = writes
      .join('')
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => line.slice(6))
    const events = data.filter(line => line !== '[DONE]').map(line => JSON.parse(line))
    const text = events
      .map(event =>
        protocol === 'responses'
          ? event.type === 'response.output_text.delta'
            ? event.delta
            : ''
          : protocol === 'chat'
            ? (event.choices[0].delta.content ?? '')
            : event.type === 'content_block_delta'
              ? event.delta.text
              : ''
      )
      .join('')
    expect(text).toBe(
      Array.from(
        { length: 40 },
        (_, index) => `Workspace selection background update ${index + 1}.\n`
      ).join('')
    )
    if (protocol === 'responses') expect(events.at(-1).type).toBe('response.completed')
    else if (protocol === 'chat') {
      expect(data.at(-1)).toBe('[DONE]')
      expect(events.at(-1).choices[0].finish_reason).toBe('stop')
    } else {
      expect(events.at(-1).type).toBe('message_stop')
      expect(events.find(event => event.type === 'message_delta').delta.stop_reason).toBe(
        'end_turn'
      )
    }
  })
}

test('unsupported text protocols cannot silently fall through to Anthropic', () => {
  expect(() => modelTextStream('unsupported', 'response', 'text')).toThrow(
    'Unsupported model text protocol'
  )
})
