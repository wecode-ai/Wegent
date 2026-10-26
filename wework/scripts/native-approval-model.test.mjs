import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { expect, test, vi } from 'vitest'
import { nativeApprovalModelResponse } from '../e2e/desktop/modules/native-approval-model.mjs'
import { readRawRequestBody, readRequestBody } from '../e2e/desktop/modules/response-protocol.mjs'

const review = {
  text: {
    format: {
      schema: {
        properties: {
          risk_level: { type: 'string' },
          user_authorization: { type: 'string' },
          outcome: { enum: ['allow', 'deny'] },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

test('separates review model requests from ordinary scenario state', async () => {
  const reviewer = vi.fn(() => ({ outcome: 'deny', risk_level: 'high', rationale: 'Private data' }))
  expect(await nativeApprovalModelResponse({ input: [] }, { reviewApproval: reviewer })).toBeNull()
  expect(reviewer).not.toHaveBeenCalled()
  expect(
    JSON.parse(await nativeApprovalModelResponse(review, { reviewApproval: reviewer }))
  ).toMatchObject({ outcome: 'deny', risk_level: 'high' })
  expect(reviewer).toHaveBeenCalledExactlyOnceWith(review)
})

test('scripts the native model while rejecting invalid custom verdicts', async () => {
  expect(JSON.parse(await nativeApprovalModelResponse(review))).toMatchObject({ outcome: 'allow' })
  await expect(nativeApprovalModelResponse(review, { reviewApproval: () => ({}) })).rejects.toThrow(
    'explicit outcome'
  )
})

test('shares the parsed body between review routing and the scenario handler', async () => {
  const request = new PassThrough()
  const first = readRequestBody(request)
  const concurrent = readRequestBody(request)
  request.end(JSON.stringify({ input: 'ordinary task' }))
  expect(await first).toEqual({ input: 'ordinary task' })
  expect(await concurrent).toBe(await first)
  expect(await readRequestBody(request)).toBe(await first)
})

test.each([false, true])(
  'shares original wire text with JSON readers (gzip=%s)',
  async compressed => {
    const request = new PassThrough()
    const text = '{ "input": "中文 ordinary task", "tools": [] }'
    const parsed = readRequestBody(request)
    const raw = readRawRequestBody(request)
    request.end(compressed ? gzipSync(text) : Buffer.from(text))
    expect(await raw).toBe(text)
    expect(await parsed).toEqual(JSON.parse(text))
    expect(await readRawRequestBody(request)).toBe(text)
    expect(await readRequestBody(request)).toBe(await parsed)
  }
)

test('propagates corrupt compressed requests instead of crashing the server', async () => {
  const request = new PassThrough()
  const parsed = readRequestBody(request)
  request.end(Buffer.from([0x1f, 0x8b, 0x00]))
  await expect(parsed).rejects.toThrow()
})

test('rejects shared readers when the request closes without an error or end', async () => {
  const request = new PassThrough()
  const parsed = readRequestBody(request)
  const raw = readRawRequestBody(request)
  const checks = Promise.all([
    expect(parsed).rejects.toThrow('Request body stream closed before end'),
    expect(raw).rejects.toThrow('Request body stream closed before end'),
  ])
  request.write('{ "input":')
  request.destroy()
  await checks
  await expect(readRequestBody(request)).rejects.toThrow('closed before end')
})
