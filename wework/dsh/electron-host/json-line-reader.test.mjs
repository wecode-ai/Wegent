import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { JsonLineReader } from './json-line-reader.js'

function fixture(limit = 1024) {
  const input = new PassThrough()
  const reader = new JsonLineReader(input, limit)
  const lines = []
  let overflows = 0
  reader.on('line', line => lines.push(line))
  reader.on('overflow', () => overflows++)
  return { input, reader, lines, overflows: () => overflows }
}

test('preserves Unicode separators and UTF-8 characters split across byte chunks', () => {
  const { input, reader, lines } = fixture()
  const value = '插件🙂\u2028line\u2029paragraph\n\r'
  const json = JSON.stringify({ value })
  for (const byte of Buffer.from(`${json}\r\n{}\n`)) input.write(Buffer.from([byte]))
  assert.deepEqual(lines, [json, '{}'])
  assert.equal(JSON.parse(lines[0]).value, value)
  reader.close()
})

test('buffers partial frames and accepts an unterminated final frame at EOF', async () => {
  const { input, lines } = fixture()
  input.write('{"value":')
  assert.deepEqual(lines, [])
  input.end('"插件"}')
  await new Promise(setImmediate)
  assert.deepEqual(lines, ['{"value":"插件"}'])
  assert.equal(input.listenerCount('data'), 0)
})

test('allows exact byte limits with LF and split CRLF', () => {
  const { input, reader, lines, overflows } = fixture(6)
  input.write('插件\n插件\r')
  input.write('\n')
  assert.deepEqual(lines, ['插件', '插件'])
  assert.equal(overflows(), 0)
  reader.close()
})

for (const chunks of [['1234567'], ['插件中'], ['1234', '567\n{}\n'], ['123456\r', 'x']]) {
  test(`rejects oversized frames before buffering further data: ${JSON.stringify(chunks)}`, () => {
    const { input, lines, overflows } = fixture(6)
    chunks.forEach(chunk => input.write(chunk))
    input.write('{}\n')
    assert.deepEqual(lines, [])
    assert.equal(overflows(), 1)
    assert.equal(input.listenerCount('data'), 0)
  })
}

test('closing during a frame callback discards the remaining frames in that chunk', () => {
  const { input, reader, lines } = fixture()
  reader.on('line', () => reader.close())
  input.write('{}\n{"mustNotRun":true}\n')
  assert.deepEqual(lines, ['{}'])
  reader.close()
  assert.equal(input.listenerCount('data'), 0)
  assert.equal(input.listenerCount('end'), 0)
  assert.equal(input.listenerCount('close'), 0)
})
