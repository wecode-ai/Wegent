import assert from 'node:assert/strict'
import test from 'node:test'
import { createSSEParser } from './sse.mjs'

test('SSE survives every chunk boundary, CRLF, multiline data and heartbeats', () => {
  const source =
    ': keep-alive\r\nevent: response.created\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\nevent: response.completed\ndata: {}\n\n'
  for (let index = 0; index <= source.length; index++) {
    const events = []
    let heartbeats = 0
    const parser = createSSEParser(
      (event) => events.push(event),
      () => heartbeats++,
    )
    parser.feed(source.slice(0, index))
    parser.feed(source.slice(index))
    parser.finish()
    assert.equal(heartbeats, 1)
    assert.deepEqual(events, [
      { event: 'response.created', data: '{"text":\n"你好"}' },
      { event: 'response.completed', data: '{}' },
    ])
  }
})

test('unterminated event is discarded at EOF instead of reporting completion', () => {
  const events = []
  const parser = createSSEParser((event) => events.push(event))
  parser.feed('event: response.completed\ndata: {}\n')
  parser.finish()
  assert.deepEqual(events, [])
})

test('a final CR blank line terminates an event', () => {
  const events = []
  const parser = createSSEParser(event => events.push(event))
  parser.feed('event: response.completed\rdata: {}\r\r')
  parser.finish()
  assert.deepEqual(events, [{ event: 'response.completed', data: '{}' }])
})
