import { expect, test } from 'vitest'
import { cloudIdentityFailure } from './cloud-identity-diagnostics'

test.each([
  ['Wegent backend is unavailable', 'dsh-api-proxy'],
  ['fallback upstream unavailable', 'hybrid-fallback'],
  ['The cloud login proxy has no upstream', 'cloud-login-proxy-fixture'],
  ['Unexpected upstream response', 'unclassified'],
])('classifies %s without exposing error response fields', async (detail, source) => {
  const secret = 'synthetic-sensitive-body'
  const error = await cloudIdentityFailure(
    Response.json({ detail, token: secret, error: `ECONNRESET ${secret}` }, { status: 502 }),
    `https://user:${secret}@backend.invalid/custom/api/users/me?token=${secret}`
  )
  expect(error.message).toContain('E2E cloud identity returned 502')
  expect(error.message).toContain(`"source":"${source}"`)
  expect(error.message).toContain('"code":"ECONNRESET"')
  expect(error.message).toContain('https://backend.invalid/custom/api/users/me')
  expect(error.message).not.toContain(secret)
  expect(error.message).not.toContain('user:')
})

test('preserves the original HTTP failure when its response stream is unreadable', async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('synthetic-secret'))
      },
    }),
    { status: 502 }
  )
  expect(
    (await cloudIdentityFailure(response, 'http://127.0.0.1:8000/api/users/me')).message
  ).toContain('E2E cloud identity returned 502')
})
