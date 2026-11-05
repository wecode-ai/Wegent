import assert from 'node:assert/strict'
import test from 'node:test'
import { createReadCursor } from './read-cursor.js'

test('read cursors expire without touching files or accepting a changed fixed window', () => {
  let now = 1000000
  const codec = createReadCursor(() => now)
  const source = { providerId: 'provider', profile: 'account', kind: 'group', id: 'selected' }
  const state = {
    time: '2026-11-05T00:30:00.123456789Z',
    issuedAt: now,
    start: '2026-11-05T00:00:00Z',
    end: '2026-11-05T01:00:00Z',
    limit: 2,
  }
  const cursor = codec.encode(source, state)
  assert.equal(codec.decode(source, { cursor }).time, state.time)
  assert.equal(codec.decode(source, { cursor, since: state.start, limit: 2 }).end, state.end)
  now += 30 * 60 * 1000 + 1
  assert.throws(() => codec.decode(source, { cursor }), { code: 'source_read_cursor_invalid' })
})
