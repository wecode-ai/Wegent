import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cleanupAssistantRequestFixture,
  matchesAssistantRequestGrant,
  restorePersonalStandInProfile,
  waitForAssistantRequestGrant,
} from './async-assistant-request-fixture.mjs'

const saved = {
  userId: 7,
  version: 8,
  primary: {
    enabled: true,
    collaboration: {
      enabled: true,
      allProjects: false,
      projects: [{ id: 'project-1', store: 'cloud' }],
      excludedProjects: [],
      tags: ['async-test'],
      policy: { automatic: true, askBeforeAct: false, immediate: true },
    },
  },
}
const grant = {
  version: 1,
  roles: [
    {
      id: '@primary',
      userId: 7,
      version: 8,
      enabled: true,
      collaboration: {
        ...saved.primary.collaboration,
        policy: { automatic: true, askBeforeAct: false },
      },
    },
  ],
}

test('the prerequisite requires the current owner, saved version and configured authorization', () => {
  assert.equal(matchesAssistantRequestGrant(grant, saved), true)
  assert.equal(matchesAssistantRequestGrant(null, saved), false)
  assert.equal(matchesAssistantRequestGrant({ version: 1, roles: [] }, saved), false)
  const changes = [
    role => (role.version = 7),
    role => (role.userId = 8),
    role => (role.enabled = false),
    role => (role.collaboration.enabled = false),
    role => (role.collaboration.projects = [{ id: 'other', store: 'cloud' }]),
    role => (role.collaboration.excludedProjects = [{ id: 'project-1', store: 'cloud' }]),
    role => (role.collaboration.tags = ['previous-test']),
    role => (role.collaboration.policy.automatic = false),
  ]
  for (const change of changes) {
    const stale = structuredClone(grant)
    change(stale.roles[0])
    assert.equal(matchesAssistantRequestGrant(stale, saved), false)
  }
})

test('readiness observes the exact owned Device grant before proceeding to an action', async () => {
  const previous = structuredClone(grant)
  previous.roles[0].version = 7
  const observations = [previous, grant]
  const captured = []
  let reads = 0
  let accepted = false
  await waitForAssistantRequestGrant({
    saved,
    deviceName: 'owned-device',
    environment: {
      async queryDatabase(sql, params) {
        assert.match(sql, /user_id = %s AND kind = 'Device' AND namespace = 'default'/)
        assert.match(sql, /name = %s AND is_active = 1/)
        assert.deepEqual(params, [7, 'owned-device'])
        assert.equal(accepted, false)
        return [{ declaration: JSON.stringify(observations[reads++]) }]
      },
    },
    observe: declaration => captured.push(declaration),
    async until(load, ready) {
      assert.equal(ready(await load()), false)
      const current = await load()
      assert.equal(ready(current), true)
      return current
    },
  })
  accepted = true
  assert.equal(reads, 2)
  assert.deepEqual(captured, observations)
})

test('profile restoration keeps original settings and uses the latest strict CAS version', async () => {
  const original = { userId: 7, version: 7, roles: [], primary: { enabled: false } }
  const calls = []
  const rpc = async (method, params) => {
    calls.push({ method, params })
    if (method === 'runtime.stand_in.personal.get') return { version: 9 }
    assert.equal(params.settings.version, 9, 'A stale version must never be submitted')
    return { ...params.settings, version: 10 }
  }
  const restored = await restorePersonalStandInProfile(rpc, 7, original)
  assert.deepEqual(restored, { ...original, version: 10 })
  assert.deepEqual(calls[1].params, { userId: 7, settings: { ...original, version: 9 } })
  assert.equal(original.version, 7)
})

test('cleanup attempts every restoration and retains the primary and cleanup errors', async () => {
  const primary = new Error('new_request: 403 authorization unavailable')
  const cancellation = new Error('cancel failed')
  const restoration = new Error('profile save failed')
  const completed = []
  await assert.rejects(
    cleanupAssistantRequestFixture(
      [
        async () => {
          throw cancellation
        },
        async () => {
          throw restoration
        },
        async () => completed.push('limits restored'),
      ],
      primary
    ),
    error => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [primary, cancellation, restoration])
      assert.match(error.message, /new_request: 403/)
      assert.match(error.message, /profile save failed/)
      return true
    }
  )
  assert.deepEqual(completed, ['limits restored'])
})

test('successful cleanup preserves the original failure and cleanup alone still fails', async () => {
  const primary = new Error('original assertion')
  await assert.rejects(
    (async () => {
      try {
        throw primary
      } finally {
        await cleanupAssistantRequestFixture([async () => {}], primary)
      }
    })(),
    error => error === primary
  )
  const restoration = new Error('profile save failed')
  await assert.rejects(
    cleanupAssistantRequestFixture([
      async () => {
        throw restoration
      },
    ]),
    error => error instanceof AggregateError && error.errors[0] === restoration
  )
})
