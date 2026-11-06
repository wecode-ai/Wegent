// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { appendInternalDate } from '../e2e/desktop/modules/real-mail-server.mjs'

test('fixture APPEND dates avoid GreenMail noon parsing', () => {
  const noon = new Date('2026-11-04T12:23:47.900Z')
  assert.equal(appendInternalDate(noon).toISOString(), '2026-11-04T11:23:47.900Z')

  const morning = new Date('2026-11-04T11:23:47.900Z')
  assert.equal(appendInternalDate(morning), morning)

  const afternoon = new Date('2026-11-04T13:23:47.900Z')
  assert.equal(appendInternalDate(afternoon), afternoon)

  assert.throws(() => appendInternalDate(new Date('invalid')), { name: 'AssertionError' })
})
