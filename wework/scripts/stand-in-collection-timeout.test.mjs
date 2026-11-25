import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { seedCollectionTimeout } from '../e2e/desktop/modules/stand-in-collection-timeout.mjs'

test('timeout regression seeds the exact legacy failure and verifies independent source recovery', async () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('CREATE TABLE loop_items (id TEXT, resource_type TEXT, metadata TEXT)')
    const insert = database.prepare('INSERT INTO loop_items VALUES (?, ?, ?)')
    for (const id of ['direct', 'group', 'silent']) {
      insert.run(
        id,
        'stand_in_source',
        JSON.stringify({
          userId: 7,
          version: 19,
          source: { providerId: 'dingtalk', id, kind: id === 'direct' ? 'direct' : 'group' },
          checkpoint: { after: '2026-11-08T22:57:19.411Z', cursor: '0' },
        })
      )
    }
    const assertRecovered = await seedCollectionTimeout(
      database,
      7,
      'dingtalk',
      ['direct', 'group'],
      1000
    )
    const timedOut = database
      .prepare(
        "SELECT id FROM loop_items WHERE json_extract(metadata, '$.error.code') = 'request_timeout' ORDER BY id"
      )
      .all()
    expect(timedOut.map(row => row.id)).toEqual(['direct', 'group'])
    expect(() => assertRecovered()).toThrow('Successful collection must clear the timeout')
    database.exec("UPDATE loop_items SET metadata=json_remove(metadata,'$.error')")
    expect(() => assertRecovered()).not.toThrow()
    database.exec("UPDATE loop_items SET metadata=json_set(metadata,'$.version',20)")
    expect(() => assertRecovered()).toThrow('Recovery must not require a settings change')
  } finally {
    database.close()
  }
})
