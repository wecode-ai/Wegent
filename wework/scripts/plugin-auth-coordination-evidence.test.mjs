// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  assertBackgroundPluginAuthPaused,
  describePluginAuthRecovery,
  hasFreshPluginAuthSuccess,
  isFreshPluginAuthRecovery,
} from '../e2e/desktop/modules/plugin-auth-coordination-evidence.mjs'

for (const cycle of ['independent-plugin', 'no-target', 'failed-target']) {
  test(`a ${cycle} cycle cannot certify completion of the fenced target`, () => {
    const fence = { held: true, blocked: true }
    const target = [
      { id: 73, kind: 'InstalledPlugin', state_hash: 'unchanged-plugin' },
      {
        id: 74,
        kind: 'ConnectorConnection',
        state_hash: 'unchanged-mail',
        status: 'connected',
        revision: 12,
        credential_present: 1,
      },
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
const connection = {
  id: 74,
  kind: 'ConnectorConnection',
  installed_plugin_id: installedId,
  connector_slug: 'mail',
  is_active: 1,
  status: 'connected',
  revision: 12,
  credential_present: 1,
  local_grants: { 'current-local-principal': true },
  state_hash: 'unchanged-mail',
}
const migration = {
  id: 75,
  name: 'previous-intent',
  kind: 'ConnectorMigration',
  installed_plugin_id: installedId,
  connector_slug: 'mail',
  local_principal: 'current-local-principal',
  operation: 'export',
  is_active: 0,
  revision: 8,
}
const completedMigration = { ...migration, name: 'new-intent', revision: 10 }
const success = (id = installedId, slug = 'mail', ok = true) =>
  `2026-11-17T08:57:58.744Z [stdout] 2026-11-17 08:57:58 plugin auth automatic enrollment finished installed_plugin_id=${id} connector_slug=${slug} ok=${ok} code=${ok ? '' : 'plugin_write_busy'}\n`

test('requires the real fence to stay held and to have blocked a write', () => {
  const state = { target: [connection], freshTargetSuccess: false }
  for (const fence of [
    { held: false, blocked: true },
    { held: true, blocked: false },
  ]) {
    assert.throws(() => assertBackgroundPluginAuthPaused({ before: state, after: state, fence }))
  }
})

test('rejects a changed target while the row is held', () => {
  const before = { target: [connection] }
  const fence = { held: true, blocked: true }
  const after = { target: [{ ...connection, revision: 13 }] }
  assert.throws(() => assertBackgroundPluginAuthPaused({ before, after, fence }))
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

test('a newly completed target intent proves recovery with unchanged idempotent connection state', () => {
  assert.equal(
    isFreshPluginAuthRecovery({
      before: [connection, migration],
      after: [connection, completedMigration],
      freshTargetSuccess: true,
      installedId,
    }),
    true
  )
})

test('completion of the intent already active at release also proves recovery', () => {
  assert.equal(
    isFreshPluginAuthRecovery({
      before: [connection, { ...migration, is_active: 1 }],
      after: [connection, { ...migration, revision: 9 }],
      freshTargetSuccess: true,
      installedId,
    }),
    true
  )
})

test('reads serialized MySQL grants and numeric JSON fields without changing the connection', () => {
  assert.equal(
    isFreshPluginAuthRecovery({
      before: [connection, { ...migration, revision: '8' }],
      after: [
        { ...connection, local_grants: JSON.stringify(connection.local_grants) },
        { ...completedMigration, installed_plugin_id: '73', revision: '10', is_active: '0' },
      ],
      freshTargetSuccess: true,
      installedId,
    }),
    true
  )
})

test('old connected state, unrelated targets, failures, and missing credentials cannot prove recovery', () => {
  const before = [connection, migration]
  const cases = [
    { after: [connection, completedMigration], freshTargetSuccess: false },
    { after: [connection, migration], freshTargetSuccess: true },
    {
      after: [{ ...connection, installed_plugin_id: 74 }, completedMigration],
      freshTargetSuccess: true,
    },
    {
      after: [{ ...connection, connector_slug: 'oauth' }, completedMigration],
      freshTargetSuccess: true,
    },
    {
      after: [{ ...connection, status: 'disconnected' }, completedMigration],
      freshTargetSuccess: true,
    },
    { after: [{ ...connection, is_active: 0 }, completedMigration], freshTargetSuccess: true },
    {
      after: [{ ...connection, credential_present: 0 }, completedMigration],
      freshTargetSuccess: true,
    },
    {
      after: [{ ...connection, local_grants: {} }, completedMigration],
      freshTargetSuccess: true,
    },
    {
      after: [
        { ...connection, local_grants: { 'current-local-principal': false } },
        completedMigration,
      ],
      freshTargetSuccess: true,
    },
    {
      after: [
        { ...connection, local_grants: { 'other-local-principal': true } },
        completedMigration,
      ],
      freshTargetSuccess: true,
    },
  ]
  for (const observation of cases) {
    assert.equal(isFreshPluginAuthRecovery({ before, installedId, ...observation }), false)
  }
})

test('does not choose an arbitrary principal when the isolated fixture has more than one', () => {
  assert.equal(
    isFreshPluginAuthRecovery({
      before: [
        connection,
        migration,
        { ...migration, id: 76, local_principal: 'other-local-principal' },
      ],
      after: [connection, completedMigration],
      freshTargetSuccess: true,
      installedId,
    }),
    false
  )
})

test('an unrelated, pending, failed, or unchanged intent cannot prove target recovery', () => {
  const before = [connection, migration]
  for (const intent of [
    { ...completedMigration, installed_plugin_id: 74 },
    { ...completedMigration, connector_slug: 'oauth' },
    { ...completedMigration, local_principal: 'other-local-principal' },
    { ...completedMigration, is_active: 1 },
    { ...completedMigration, operation: 'failed' },
    { ...completedMigration, revision: migration.revision },
    { ...completedMigration, name: migration.name },
  ]) {
    assert.equal(
      isFreshPluginAuthRecovery({
        before,
        after: [connection, intent],
        freshTargetSuccess: true,
        installedId,
      }),
      false
    )
  }
})

test('diagnostic flags identify each unmet recovery condition without changing acceptance', () => {
  const recovered = {
    before: [connection, migration],
    after: [connection, completedMigration],
    freshTargetSuccess: true,
    installedId,
  }
  assert.equal(describePluginAuthRecovery(recovered).accepted, true)
  assert.ok(Object.values(describePluginAuthRecovery(recovered).checks).every(Boolean))
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
    ['singleTargetPrincipal', { before: [connection] }],
    ['targetPrincipalPresent', { before: [connection, { ...migration, local_principal: '' }] }],
    [
      'targetPrincipalGranted',
      { after: [{ ...connection, local_grants: { unrelated: true } }, completedMigration] },
    ],
    [
      'matchingMigrationPresent',
      { after: [connection, { ...completedMigration, local_principal: 'unrelated' }] },
    ],
    ['migrationExport', { after: [connection, { ...completedMigration, operation: 'failed' }] }],
    ['migrationInactive', { after: [connection, { ...completedMigration, is_active: 1 }] }],
    [
      'migrationRevisionAdvanced',
      { after: [connection, { ...completedMigration, revision: migration.revision }] },
    ],
    [
      'migrationGenerationAdvanced',
      { after: [connection, { ...completedMigration, name: migration.name }] },
    ],
  ]
  for (const [failedCondition, changes] of cases) {
    const observation = { ...recovered, ...changes }
    const description = describePluginAuthRecovery(observation)
    assert.equal(description.checks[failedCondition], false, failedCondition)
    assert.equal(description.accepted, false, failedCondition)
    assert.equal(description.accepted, isFreshPluginAuthRecovery(observation), failedCondition)
  }
})

test('recovery diagnostics retain only scoped metadata and hashes, never credentials or grants', () => {
  const privatePrincipal = 'private-current-local-principal'
  const privateGrant = 'private-unrelated-local-principal'
  const previousNonce = 'private-previous-migration-nonce'
  const currentNonce = 'private-current-migration-nonce'
  const secretCredential = 'private-credential-value'
  const secretStateHash = 'private-state-hash'
  const current = {
    ...connection,
    credential: secretCredential,
    local_grants: JSON.stringify({ [privatePrincipal]: true, [privateGrant]: true }),
    state_hash: secretStateHash,
  }
  const previous = { ...migration, name: previousNonce, local_principal: privatePrincipal }
  const completed = {
    ...completedMigration,
    name: currentNonce,
    local_principal: privatePrincipal,
    credential: secretCredential,
  }
  const diagnostic = describePluginAuthRecovery({
    before: [current, previous],
    after: [current, completed],
    freshTargetSuccess: true,
    installedId,
  })
  assert.equal(diagnostic.accepted, true)
  assert.equal(diagnostic.after[0].matchingPrincipalGrant, true)
  assert.equal(diagnostic.before[1].migrationNonceChanged, false)
  assert.equal(diagnostic.after[1].migrationNonceChanged, true)
  assert.match(diagnostic.after[1].migrationNonceHash, /^[a-f0-9]{64}$/)
  assert.match(diagnostic.after[1].principalHash, /^[a-f0-9]{64}$/)
  assert.equal(diagnostic.before[1].principalHash, diagnostic.after[1].principalHash)
  assert.notEqual(diagnostic.before[1].migrationNonceHash, diagnostic.after[1].migrationNonceHash)
  const serialized = JSON.stringify(diagnostic)
  for (const secret of [
    privatePrincipal,
    privateGrant,
    previousNonce,
    currentNonce,
    secretCredential,
    secretStateHash,
    'local_grants',
  ]) {
    assert.equal(serialized.includes(secret), false, secret)
  }
})

test('recovery still rejects missing events and ambiguous principals before decoding grants', () => {
  const malformed = { ...connection, local_grants: 'not-json' }
  assert.equal(
    isFreshPluginAuthRecovery({
      before: [connection, migration],
      after: [malformed, completedMigration],
      freshTargetSuccess: false,
      installedId,
    }),
    false
  )
  assert.equal(
    isFreshPluginAuthRecovery({
      before: [connection, migration, { ...migration, id: 76 }],
      after: [malformed, completedMigration],
      freshTargetSuccess: true,
      installedId,
    }),
    false
  )
  assert.throws(() =>
    isFreshPluginAuthRecovery({
      before: [connection, migration],
      after: [malformed, completedMigration],
      freshTargetSuccess: true,
      installedId,
    })
  )
})
