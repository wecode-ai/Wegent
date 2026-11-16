import assert from 'node:assert/strict'
import { storyUntil } from './stand-in-source-story-evidence.mjs'

/** Reproduce the persisted local failure without changing the authorized sources. */
export async function seedCollectionTimeout(database, userId, providerId, timeoutMs) {
  const rows = () =>
    database
      .prepare(
        "SELECT id, metadata FROM loop_items WHERE resource_type='stand_in_source' AND json_extract(metadata,'$.userId')=? AND json_extract(metadata,'$.source.providerId')=?"
      )
      .all(userId, providerId)
  await storyUntil(
    async () => rows(),
    value => value.length === 2 && value.every(row => JSON.parse(row.metadata).checkpoint),
    timeoutMs,
    'Both connected sources must establish their original collection checkpoints'
  )
  const original = rows().map(row => ({ ...row, state: JSON.parse(row.metadata) }))
  const update = database.prepare(
    "UPDATE loop_items SET metadata=json_set(metadata,'$.error',json(?)) WHERE id=?"
  )
  for (const row of original) {
    assert.equal(
      update.run(
        JSON.stringify({
          code: 'request_timeout',
          message: 'Executor request runtime.connections.cli timed out',
        }),
        row.id
      ).changes,
      1
    )
  }
  return () => {
    const recovered = rows()
    assert.equal(recovered.length, original.length, 'Recovery must retain both sources')
    for (const row of recovered) {
      const state = JSON.parse(row.metadata)
      const before = original.find(item => item.id === row.id).state
      assert.equal(state.error, undefined, 'Successful collection must clear the timeout')
      assert.equal(state.version, before.version, 'Recovery must not require a settings change')
      assert.ok(
        Date.parse(state.checkpoint.after) >= Date.parse(before.checkpoint.after),
        'Collection must preserve progress rather than resetting the cursor'
      )
    }
  }
}
