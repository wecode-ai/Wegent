import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveDistinctId, IdentityError } from './identity.js'

test('uses the cloud email prefix directly as the distinct id', () => {
  assert.equal(deriveDistinctId({ emailPrefix: 'cloud-user' }), 'cloud-user')
})

test('does not derive an identifier from a local numeric user id', () => {
  assert.throws(
    () => deriveDistinctId({ id: 42 }),
    error => error instanceof IdentityError && error.code === 'identity_unavailable'
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
      () => deriveDistinctId(user),
      error => error instanceof IdentityError && error.code === 'identity_unavailable'
    )
  }
})
