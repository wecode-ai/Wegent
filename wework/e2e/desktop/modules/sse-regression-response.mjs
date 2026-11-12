import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'

// Reuse the model oracle's protocol events, varying only their SSE transport.
export async function writeSseRegressionResponse(response, write, protocol) {
  let headers
  let source
  write({
    writeHead(status, value) {
      assert.equal(status, 200)
      headers = value
    },
    end(value) {
      source = value
    },
  })
  assert.equal(typeof source, 'string')
  const frames = source
    .trim()
    .split('\n\n')
    .map((block, index) => {
      const data = block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      const ending = ['\n', '\r\n', '\r'][index % 3]
      const header =
        protocol === 'responses' && index === 0
          ? `event: response.completed${ending}`
          : index % 2 === 0
            ? `event: message${ending}`
            : ''
      const payload = data === '[DONE]' ? data : JSON.stringify(JSON.parse(data), null, 2)
      return `${header}${payload
        .split('\n')
        .map(line => `data: ${line}${ending}`)
        .join('')}${ending}`
    })
  response.writeHead(200, headers)
  // A misleading terminal header must not discard subsequent network chunks.
  response.write(frames.shift())
  await setImmediate()
  const rest = Buffer.from(frames.join(''))
  const chinese = rest.indexOf(Buffer.from('中文'))
  const split = chinese >= 0 ? chinese + 1 : Math.max(1, Math.floor(rest.length / 2))
  response.write(rest.subarray(0, split))
  await setImmediate()
  response.end(rest.subarray(split))
}
