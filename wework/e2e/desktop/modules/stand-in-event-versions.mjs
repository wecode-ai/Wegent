import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Exercise real plugin collection and durable intake without invoking a model. */
export async function verifyStandInEventVersions(control, rpc, providerId, executorHome, records) {
  const user = 9001
  const sourceId = 'versioned-record'
  const originalRecords = await readFile(records, 'utf8')
  const original = await rpc(control, 'runtime.stand_in.personal.get', { userId: user })
  const database = new DatabaseSync(join(executorHome, 'data', 'tasks.sqlite'), { readOnly: true })
  database.exec('PRAGMA busy_timeout = 10000')
  const read = kind =>
    database
      .prepare(
        "SELECT metadata FROM loop_items WHERE resource_type=? AND json_extract(metadata,'$.userId')=? AND json_extract(metadata,'$.source.providerId')=? AND json_extract(metadata,'$.source.id')=?"
      )
      .all(kind, user, providerId, sourceId)
      .map(row => JSON.parse(row.metadata))
  const snapshot = () => ({
    events: read('stand_in_event'),
    cursor: Number(read('stand_in_source')[0]?.checkpoint?.cursor ?? 0),
  })
  async function waitForCollection(ready) {
    // The production scheduler polls every 15 seconds. Observe persisted progress,
    // rather than treating a fixed delay as evidence that collection occurred.
    const deadline = Date.now() + 30000
    let latest
    while (Date.now() < deadline) {
      latest = snapshot()
      if (ready(latest)) return latest
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(`Versioned collection did not settle: ${JSON.stringify(latest)}`)
  }
  async function publish(version, value) {
    await writeFile(
      records,
      JSON.stringify([...JSON.parse(originalRecords), { id: sourceId, version, value }])
    )
  }
  try {
    await publish('checks-passed', 'All checks passed')
    const page = await rpc(control, 'runtime.connections.resources', {
      providerId,
      kind: 'record',
      query: sourceId,
    })
    assert.equal(page.items.length, 1)
    await rpc(control, 'runtime.stand_in.personal.save', {
      userId: user,
      settings: {
        ...original,
        roles: [],
        primary: {
          ...original.primary,
          enabled: true,
          prompt: '',
          preferences: '',
          connections: [
            {
              ...page.items[0],
              policy: { automatic: true, askBeforeAct: true, immediate: false },
            },
          ],
        },
      },
    })
    const first = await waitForCollection(state => state.cursor >= 1 && state.events.length === 1)
    assert.equal(first.events[0].message.version, 'checks-passed')
    assert.equal(first.events[0].status, 'pending')
    const repeated = await waitForCollection(state => state.cursor > first.cursor)
    assert.equal(repeated.events.length, 1, 'A replayed object revision must not create new work')
    assert.equal(repeated.events[0].id, first.events[0].id)
    await publish('checks-failed', 'The same PR now has a failing check')
    const changed = await waitForCollection(state => state.events.length === 2)
    assert.deepEqual(changed.events.map(event => event.message.version).sort(), [
      'checks-failed',
      'checks-passed',
    ])
    assert.equal(new Set(changed.events.map(event => event.message.id)).size, 1)
    assert.equal(new Set(changed.events.map(event => event.message.objectId)).size, 1)
    assert.equal(new Set(changed.events.map(event => event.id)).size, 2)
    assert.ok(changed.events.every(event => event.status === 'pending'))
    const processing = await rpc(control, 'runtime.stand_in.processing.status', { userId: user })
    assert.equal(
      processing.running,
      false,
      'Collection must not bypass the saved assessment window'
    )
  } finally {
    try {
      const current = await rpc(control, 'runtime.stand_in.personal.get', { userId: user })
      await rpc(control, 'runtime.stand_in.personal.save', {
        userId: user,
        settings: { ...original, version: current.version },
      })
    } finally {
      database.close()
      await writeFile(records, originalRecords)
    }
  }
}
