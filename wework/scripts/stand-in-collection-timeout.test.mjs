import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { seedCollectionTimeout } from '../e2e/desktop/modules/stand-in-collection-timeout.mjs'

test('timeout regression seeds the exact legacy failure and verifies independent source recovery', async () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('CREATE TABLE loop_items (id TEXT, resource_type TEXT, metadata TEXT)')
    const insert = database.prepare('INSERT INTO loop_items VALUES (?, ?, ?)')
    for (const kind of ['direct', 'group']) {
      insert.run(
        kind,
        'stand_in_source',
        JSON.stringify({
          userId: 7,
          version: 19,
          source: { providerId: 'dingtalk', kind },
          checkpoint: { after: '2026-11-08T22:57:19.411Z', cursor: '0' },
        })
      )
    }
    const assertRecovered = await seedCollectionTimeout(database, 7, 'dingtalk', 1000)
    expect(() => assertRecovered()).toThrow('Successful collection must clear the timeout')
    database.exec("UPDATE loop_items SET metadata=json_remove(metadata,'$.error')")
    expect(() => assertRecovered()).not.toThrow()
    database.exec("UPDATE loop_items SET metadata=json_set(metadata,'$.version',20)")
    expect(() => assertRecovered()).toThrow('Recovery must not require a settings change')
  } finally {
    database.close()
  }
})
