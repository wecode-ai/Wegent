import assert from 'node:assert/strict'

export async function prepareHistoryRetention({ database, rpc, until, userId, historyCount }) {
  // Observe two normal polling intervals before pausing this fixture's writer.
  const observationEnds = Date.now() + 10_000
  do {
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM loop_items WHERE resource_type='stand_in_action' AND json_extract(metadata,'$.status')='failed'"
        )
        .get().count,
      historyCount,
      'Background polling must not replan failed events'
    )
    await new Promise(resolve => setTimeout(resolve, 500))
  } while (Date.now() < observationEnds)
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM loop_items WHERE resource_type='stand_in_action' AND json_extract(metadata,'$.status')='failed'"
      )
      .get().count,
    historyCount
  )

  const settings = await rpc('runtime.stand_in.personal.get', { userId })
  await rpc('runtime.stand_in.personal.save', {
    userId,
    settings: {
      ...settings,
      primary: { ...settings.primary, enabled: false },
      roles: settings.roles.map(role => ({ ...role, enabled: false })),
    },
  })
  // This status shares the coordinator gate, so earlier commits finish first.
  await until(
    () => rpc('runtime.coordination.status', { contextId: `personal:${userId}` }),
    state => state.running === false && state.batchId === null,
    'The fixture coordinator must be idle before independent history maintenance'
  )
}
