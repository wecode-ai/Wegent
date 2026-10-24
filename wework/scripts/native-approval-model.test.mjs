import { PassThrough } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { nativeApprovalModelResponse } from '../e2e/desktop/modules/native-approval-model.mjs'
import { readRequestBody } from '../e2e/desktop/modules/response-protocol.mjs'

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
