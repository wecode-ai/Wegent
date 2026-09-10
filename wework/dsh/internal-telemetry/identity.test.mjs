import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveDistinctId, IdentityError } from './identity.js'

const HMAC_KEY = '0123456789abcdef0123456789abcdef'

test('derives a stable distinct id from only the numeric user id', () => {
  const first = deriveDistinctId(
    { id: 42, email: 'private@example.com', userName: 'private-user' },
    HMAC_KEY
  )
  const second = deriveDistinctId(
    { id: 42, email: 'other@example.com', userName: 'other-user' },
    HMAC_KEY
  )

  assert.equal(first, second)
  assert.match(first, /^wework:[0-9a-f]{64}$/)
  assert.equal(first.includes('42'), false)
  assert.equal(first.includes('private'), false)
})

test('separates distinct ids for different users and HMAC keys', () => {
  const user = { id: 42 }

  assert.notEqual(deriveDistinctId(user, HMAC_KEY), deriveDistinctId({ id: 43 }, HMAC_KEY))
  assert.notEqual(
    deriveDistinctId(user, HMAC_KEY),
    deriveDistinctId(user, 'abcdef0123456789abcdef0123456789')
  )
})

test('rejects missing or unsafe user identifiers with a stable reason', () => {
  for (const user of [
    null,
    {},
    { id: 0 },
    { id: -1 },
    { id: 1.5 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(
      () => deriveDistinctId(user, HMAC_KEY),
      error => error instanceof IdentityError && error.code === 'identity_unavailable'
    )
  }
})
