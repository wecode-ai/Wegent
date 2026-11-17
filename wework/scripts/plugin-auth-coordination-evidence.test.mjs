// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  assertBackgroundPluginAuthPaused,
  describePluginAuthRecovery,
  hasFreshPluginAuthSuccess,
  isFreshPluginAuthRecovery,
  readPluginAuthTarget,
} from '../e2e/desktop/modules/plugin-auth-coordination-evidence.mjs'

for (const cycle of ['independent-plugin', 'no-target', 'failed-target']) {
  test(`a ${cycle} cycle cannot certify completion of the fenced target`, () => {
    const fence = { held: true, blocked: true }
    const target = [
      { id: 73, kind: 'InstalledPlugin', state_hash: 'unchanged-plugin' },
      { id: 74, kind: 'ConnectorConnection', state_hash: 'unchanged-mail' },
    ]
    const before = { target, marker: 'reconciled\n' }
    const after = {
      target: structuredClone(target),
      marker: `${before.marker}reconciled\n`,
      freshTargetSuccess: false,
      cycle,
    }
    assert.equal(fence.held, true)
    assert.equal(fence.blocked, true)
    assert.deepEqual(after.target, before.target)
    assert.doesNotThrow(() => assertBackgroundPluginAuthPaused({ before, after, fence }))
  })
}

const installedId = 73
const expectedDeviceId = 'app-record-71'
const binding = {
  deviceRowId: 71,
  runtimeDeviceId: expectedDeviceId,
  runtimeInstanceId: 'current-runtime-instance',
}
const connection = {
  id: 74,
  kind: 'ConnectorConnection',
  installed_plugin_id: installedId,
  connector_slug: 'mail',
  is_active: 1,
  status: 'connected',
  revision: 29,
  credential_present: 1,
  device_grants: { [expectedDeviceId]: binding },
  state_hash: 'unchanged-mail',
}
// The released Socket migration_spec stores device_id/binding, not a native
// HTTP principal or migration revision. Consuming a new intent may be idempotent.
const migration = {
  id: 75,
  name: 'a'.repeat(64),
  kind: 'ConnectorMigration',
  installed_plugin_id: installedId,
  connector_slug: 'mail',
  device_id: expectedDeviceId,
  binding,
  operation: 'export',
  is_active: 0,
  revision: null,
  local_principal: null,
}
const completedMigration = { ...migration, name: 'b'.repeat(64) }
const recovery = (changes = {}) => ({
  before: [connection, migration],
  after: [connection, completedMigration],
  freshTargetSuccess: true,
  installedId,
  expectedDeviceId,
  expectedDeviceBinding: binding,
  ...changes,
})
const success = (id = installedId, slug = 'mail', ok = true) =>
  `2026-11-17T08:57:58.744Z [stdout] 2026-11-17 08:57:58 plugin auth automatic enrollment finished installed_plugin_id=${id} connector_slug=${slug} ok=${ok} code=${ok ? '' : 'plugin_write_busy'}\n`

test('requires the real fence to stay held and to have blocked a write', () => {
  const state = { target: [connection] }
  for (const fence of [
    { held: false, blocked: true },
    { held: true, blocked: false },
  ]) {
    assert.throws(() => assertBackgroundPluginAuthPaused({ before: state, after: state, fence }))
  }
})

test('rejects a changed target while the row is held', () => {
  const before = { target: [connection] }
  const after = { target: [{ ...connection, revision: 30 }] }
  const fence = { held: true, blocked: true }
  assert.throws(() => assertBackgroundPluginAuthPaused({ before, after, fence }))
})

test('changed fenced targets fail without serializing raw snapshots in assertion details', () => {
  const before = { target: [connection, migration] }
  const fence = { held: true, blocked: true }
  const changedRuntime = 'private-changed-runtime-instance'
  const changedConnection = {
    ...connection,
    device_grants: {
      [expectedDeviceId]: { ...binding, runtimeInstanceId: changedRuntime },
    },
  }
  for (const after of [
    { target: [changedConnection, completedMigration] },
    { target: [{ ...connection, state_hash: 'changed-unprojected-state' }, migration] },
  ]) {
    let failure
    try {
      assertBackgroundPluginAuthPaused({ before, after, fence })
    } catch (error) {
      failure = error
    }
    assert.ok(failure, 'Every changed snapshot must still fail the held guard')
    assert.match(failure.message, /Background authentication changed the fenced target account/)
    const serialized = JSON.stringify({
      message: failure.message,
      actual: failure.actual,
      expected: failure.expected,
    })
    for (const secret of [
      migration.name,
      completedMigration.name,
      expectedDeviceId,
      binding.runtimeInstanceId,
      changedRuntime,
      'device_grants',
      'runtimeInstanceId',
    ]) {
      assert.equal(serialized.includes(secret), false, 'Assertion details leaked a raw snapshot')
    }
    assert.equal(failure.actual === false, true, 'Assertion actual must be a boolean')
    assert.equal(failure.expected === true, true, 'Assertion expected must be a boolean')
  }
})

test('a buffered earlier target event cannot override unchanged fenced business state', () => {
  const before = { target: [connection] }
  const after = { target: structuredClone(before.target), freshTargetSuccess: true }
  const fence = { held: true, blocked: true }
  assert.doesNotThrow(() => assertBackgroundPluginAuthPaused({ before, after, fence }))
})

test('requires a fresh success for exactly the installed plugin and mail connector', () => {
  const old = success()
  assert.equal(hasFreshPluginAuthSuccess(old, old.length, installedId), false)
  for (const unrelated of [
    success(74),
    success(installedId, 'oauth'),
    success(installedId, 'mail', false),
  ]) {
    assert.equal(hasFreshPluginAuthSuccess(old + unrelated, old.length, installedId), false)
  }
  assert.equal(hasFreshPluginAuthSuccess(old + 'reconciled\n', old.length, installedId), false)
  assert.equal(hasFreshPluginAuthSuccess(old + success(), old.length, installedId), true)
})

test('requires a complete executor record and excludes a record started before the offset', () => {
  const event = success()
  assert.equal(hasFreshPluginAuthSuccess(event.slice(0, -1), 0, installedId), false)
  assert.equal(hasFreshPluginAuthSuccess(`unrelated prefix ${event}`, 0, installedId), false)
  assert.equal(
    hasFreshPluginAuthSuccess(event.replace('[stdout]', '[stderr]'), 0, installedId),
    false
  )
  assert.equal(hasFreshPluginAuthSuccess(event, event.length - 8, installedId), false)
  assert.equal(hasFreshPluginAuthSuccess(event + event, event.length - 8, installedId), true)
  assert.equal(
    hasFreshPluginAuthSuccess(event.replace(/^\S+ \[stdout\] /, ''), 0, installedId),
    true
  )
})

test('a consumed new Socket intent proves recovery with an unchanged idempotent connection', () => {
  assert.equal(migration.local_principal, null)
  assert.equal(migration.revision, null)
  assert.equal(connection.revision, 29)
  assert.equal(isFreshPluginAuthRecovery(recovery()), true)
})

test('completion of the intent already active at release also proves recovery', () => {
  assert.equal(
    isFreshPluginAuthRecovery(
      recovery({
        before: [connection, { ...migration, is_active: 1 }],
        after: [connection, migration],
      })
    ),
    true
  )
})

test('reads serialized MySQL bindings, grants and numeric fields', () => {
  assert.equal(
    isFreshPluginAuthRecovery(
      recovery({
        before: [connection, { ...migration, binding: JSON.stringify(binding) }],
        after: [
          { ...connection, device_grants: JSON.stringify(connection.device_grants) },
          {
            ...completedMigration,
            installed_plugin_id: '73',
            is_active: '0',
            binding: JSON.stringify(binding),
          },
        ],
      })
    ),
    true
  )
})

test('queries the persisted Socket migration device and binding with object-valued connection grants', async () => {
  const documents = [
    { id: 73, kind: 'InstalledPlugin', spec: {} },
    { ...connection, spec: { deviceGrants: connection.device_grants } },
    { ...completedMigration, spec: { device_id: expectedDeviceId, binding } },
  ]
  const cloud = {
    async queryDatabase(sql) {
      return documents.map(({ spec, ...row }) => {
        const read = alias => {
          const expression = sql.match(
            new RegExp(`JSON_EXTRACT\\(json, '\\$\\.spec\\.([^']+)'\\)\\)? AS ${alias}\\b`)
          )
          assert.ok(expression, `Missing persisted JSON projection for ${alias}`)
          return spec[expression[1]] ?? null
        }
        return {
          ...row,
          device_id: read('device_id'),
          binding: read('binding'),
          device_grants: read('device_grants'),
        }
      })
    },
  }
  const after = await readPluginAuthTarget(cloud, installedId)
  assert.equal(isFreshPluginAuthRecovery(recovery({ after })), true)
})

test('native acknowledgments, old connected state, missing credentials and wrong grants cannot prove recovery', () => {
  const cases = [
    { freshTargetSuccess: false },
    { after: [connection, migration] },
    { after: [{ ...connection, installed_plugin_id: 74 }, completedMigration] },
    { after: [{ ...connection, connector_slug: 'oauth' }, completedMigration] },
    { after: [{ ...connection, status: 'disconnected' }, completedMigration] },
    { after: [{ ...connection, is_active: 0 }, completedMigration] },
    { after: [{ ...connection, credential_present: 0 }, completedMigration] },
    { after: [{ ...connection, device_grants: {} }, completedMigration] },
    { after: [{ ...connection, device_grants: { [expectedDeviceId]: true } }, completedMigration] },
    { after: [{ ...connection, device_grants: { 'app-record-72': binding } }, completedMigration] },
  ]
  for (const changes of cases) assert.equal(isFreshPluginAuthRecovery(recovery(changes)), false)
})

test('does not choose an arbitrary App when the fixture has more than one migration', () => {
  assert.equal(
    isFreshPluginAuthRecovery(
      recovery({
        before: [connection, migration, { ...migration, id: 76, device_id: 'app-record-72' }],
      })
    ),
    false
  )
})

test('an unrelated, pending, failed or nameless intent cannot prove target recovery', () => {
  for (const intent of [
    { ...completedMigration, installed_plugin_id: 74 },
    { ...completedMigration, connector_slug: 'oauth' },
    { ...completedMigration, id: 76 },
    { ...completedMigration, device_id: 'app-record-72' },
    { ...completedMigration, is_active: 1 },
    { ...completedMigration, operation: 'failed' },
    { ...completedMigration, name: migration.name },
    { ...completedMigration, name: null },
    { ...completedMigration, name: '' },
  ]) {
    assert.equal(isFreshPluginAuthRecovery(recovery({ after: [connection, intent] })), false)
  }
  assert.equal(
    isFreshPluginAuthRecovery(recovery({ before: [connection, { ...migration, name: null }] })),
    false
  )
})

test('requires the expected current App record and runtime binding, even when stale documents agree', () => {
  const staleBinding = { ...binding, runtimeInstanceId: 'old-runtime-instance' }
  const otherBinding = {
    deviceRowId: 72,
    runtimeDeviceId: 'app-record-72',
    runtimeInstanceId: 'other-runtime',
  }
  const staleConnection = { ...connection, device_grants: { [expectedDeviceId]: staleBinding } }
  const cases = [
    { expectedDeviceId: undefined },
    { expectedDeviceId: 'ipc-app-alias' },
    { expectedDeviceBinding: undefined },
    { expectedDeviceBinding: { ...binding, deviceRowId: 72 } },
    { expectedDeviceBinding: { ...binding, runtimeDeviceId: 'app-record-72' } },
    { expectedDeviceBinding: { ...binding, runtimeInstanceId: '' } },
    { after: [staleConnection, completedMigration] },
    { after: [connection, { ...completedMigration, binding: staleBinding }] },
    {
      before: [staleConnection, { ...migration, binding: staleBinding }],
      after: [staleConnection, { ...completedMigration, binding: staleBinding }],
    },
    {
      before: [connection, { ...migration, device_id: 'app-record-72', binding: otherBinding }],
      after: [
        { ...connection, device_grants: { 'app-record-72': otherBinding } },
        { ...completedMigration, device_id: 'app-record-72', binding: otherBinding },
      ],
    },
  ]
  for (const changes of cases) assert.equal(isFreshPluginAuthRecovery(recovery(changes)), false)
})

test('diagnostic flags identify the exact unmet recovery conditions', () => {
  assert.equal(describePluginAuthRecovery(recovery()).accepted, true)
  assert.ok(Object.values(describePluginAuthRecovery(recovery()).checks).every(Boolean))
  const cases = [
    ['freshTargetSuccess', { freshTargetSuccess: false }],
    ['baselineConnectionPresent', { before: [migration] }],
    ['currentConnectionPresent', { after: [completedMigration] }],
    ['connectionIdUnchanged', { after: [{ ...connection, id: 76 }, completedMigration] }],
    ['connectionActive', { after: [{ ...connection, is_active: 0 }, completedMigration] }],
    [
      'connectionConnected',
      { after: [{ ...connection, status: 'disconnected' }, completedMigration] },
    ],
    [
      'credentialPresent',
      { after: [{ ...connection, credential_present: 0 }, completedMigration] },
    ],
    ['singleTargetDevice', { before: [connection] }],
    ['expectedAppDevice', { expectedDeviceBinding: undefined }],
    ['targetDeviceMatches', { before: [connection, { ...migration, device_id: 'app-record-72' }] }],
    [
      'targetAppBindingValid',
      { before: [connection, { ...migration, binding: { ...binding, runtimeInstanceId: 'old' } }] },
    ],
    ['targetDeviceGranted', { after: [{ ...connection, device_grants: {} }, completedMigration] }],
    ['matchingMigrationPresent', { after: [connection, { ...completedMigration, id: 76 }] }],
    [
      'migrationBindingUnchanged',
      {
        after: [
          connection,
          { ...completedMigration, binding: { ...binding, runtimeInstanceId: 'old' } },
        ],
      },
    ],
    ['migrationExport', { after: [connection, { ...completedMigration, operation: 'failed' }] }],
    ['migrationInactive', { after: [connection, { ...completedMigration, is_active: 1 }] }],
    ['migrationNoncePresent', { after: [connection, { ...completedMigration, name: null }] }],
    ['migrationGenerationAdvanced', { after: [connection, migration] }],
  ]
  for (const [failedCondition, changes] of cases) {
    const observation = recovery(changes)
    const description = describePluginAuthRecovery(observation)
    assert.equal(description.checks[failedCondition], false, failedCondition)
    assert.equal(description.accepted, false, failedCondition)
    assert.equal(description.accepted, isFreshPluginAuthRecovery(observation), failedCondition)
  }
})

test('recovery diagnostics retain only scoped metadata and hashes, never bindings, credentials or grants', () => {
  const privateBinding = { ...binding, runtimeInstanceId: 'private-runtime-instance' }
  const serializedBinding = JSON.stringify(
    {
      runtimeInstanceId: privateBinding.runtimeInstanceId,
      runtimeDeviceId: expectedDeviceId,
      deviceRowId: 71,
    },
    null,
    2
  )
  const credential = 'private-credential-value'
  const stateHash = 'private-state-hash'
  const current = {
    ...connection,
    credential,
    device_grants: JSON.stringify({
      [expectedDeviceId]: privateBinding,
      'private-other-device': privateBinding,
    }),
    state_hash: stateHash,
  }
  const diagnostic = describePluginAuthRecovery(
    recovery({
      expectedDeviceBinding: privateBinding,
      before: [current, { ...migration, binding: privateBinding }],
      after: [current, { ...completedMigration, binding: serializedBinding }],
    })
  )
  assert.equal(diagnostic.accepted, true)
  assert.equal(diagnostic.after[0].matchingDeviceGrant, true)
  assert.equal(diagnostic.before[1].migrationNonceChanged, false)
  assert.equal(diagnostic.after[1].migrationNonceChanged, true)
  assert.match(diagnostic.after[1].migrationNonceHash, /^[a-f0-9]{64}$/)
  assert.match(diagnostic.after[1].bindingHash, /^[a-f0-9]{64}$/)
  assert.equal(diagnostic.expectedDeviceHash, diagnostic.after[1].deviceHash)
  assert.equal(diagnostic.expectedBindingHash, diagnostic.after[1].bindingHash)
  assert.notEqual(diagnostic.before[1].migrationNonceHash, diagnostic.after[1].migrationNonceHash)
  const serialized = JSON.stringify(diagnostic)
  for (const secret of [
    expectedDeviceId,
    privateBinding.runtimeInstanceId,
    'private-other-device',
    migration.name,
    completedMigration.name,
    credential,
    stateHash,
    'device_grants',
  ]) {
    assert.equal(serialized.includes(secret), false, secret)
  }
})

test('recovery rejects missing events and ambiguous devices before decoding grants', () => {
  const malformed = { ...connection, device_grants: 'not-json' }
  assert.equal(
    isFreshPluginAuthRecovery(
      recovery({
        after: [malformed, completedMigration],
        freshTargetSuccess: false,
      })
    ),
    false
  )
  assert.equal(
    isFreshPluginAuthRecovery(
      recovery({
        before: [connection, migration, { ...migration, id: 76 }],
        after: [malformed, completedMigration],
      })
    ),
    false
  )
  assert.throws(() =>
    isFreshPluginAuthRecovery(recovery({ after: [malformed, completedMigration] }))
  )
})
