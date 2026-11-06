import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from './checkpoint-catalog.mjs'
import {
  DESKTOP_CHECKPOINTS,
  DESKTOP_CHECKPOINT_CI_HOSTS,
  DESKTOP_CHECKPOINT_GROUPS,
  CHECKPOINT_SCENARIO_MODULES,
  SCENARIO_ONLY_CHECKPOINTS,
  expandDesktopCheckpoints,
} from './checkpoints.mjs'
import {
  UPGRADE_CHECKPOINTS,
  UPGRADE_CHECKPOINT_GROUP,
  UPGRADE_PACKAGE_CHECKPOINTS,
  UPGRADE_DIAGNOSTIC_CHECKPOINTS,
  upgradeVerificationCheckpoint,
} from './upgrade-suite.mjs'

test('Responses retains standalone selection and shares an existing CI Cloud lifecycle', () => {
  assert.deepEqual(expandDesktopCheckpoints(['responses-api-gateway']), ['responses-api-gateway'])
  assert.equal(DESKTOP_CHECKPOINT_CI_HOSTS.get('responses-api-gateway'), 'plugin-account-auth-dws')
  for (const [checkpoint, host] of DESKTOP_CHECKPOINT_CI_HOSTS) {
    assert.ok(DESKTOP_CHECKPOINTS.includes(checkpoint), checkpoint)
    assert.ok(DESKTOP_CHECKPOINTS.includes(host), host)
    assert.notEqual(checkpoint, host)
  }
})

test('Windows certifies the core round trip while macOS retains complete recovery coverage', () => {
  assert.deepEqual(expandDesktopCheckpoints([UPGRADE_CHECKPOINT_GROUP]), UPGRADE_CHECKPOINTS)
  assert.deepEqual(expandDesktopCheckpoints([upgradeVerificationCheckpoint('windows')]), [
    'app-rollback',
  ])
  assert.deepEqual(
    expandDesktopCheckpoints([upgradeVerificationCheckpoint('macos')]),
    UPGRADE_CHECKPOINTS
  )
  assert.throws(
    () => upgradeVerificationCheckpoint('linux'),
    /Unsupported upgrade verification platform/
  )
  for (const checkpoint of UPGRADE_CHECKPOINTS) assert.ok(DESKTOP_CHECKPOINTS.includes(checkpoint))
})

test('the refresh diagnostic uses the shared package runner without certifying an upgrade edge', () => {
  assert.ok(DESKTOP_CHECKPOINTS.includes('app-update-refresh'))
  assert.ok(UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes('app-update-refresh'))
  assert.equal(UPGRADE_PACKAGE_CHECKPOINTS.includes('app-update-refresh'), false)
})

test('the existing archive CI shard includes deletion without dropping default coverage', () => {
  assert.deepEqual(expandDesktopCheckpoints(['collaboration-issue-archive']), [
    'collaboration-issue-archive',
  ])
  assert.equal(
    CHECKPOINT_SCENARIO_MODULES['collaboration-space-deletion'],
    './scenarios/collaboration-space-deletion.scenario.mjs'
  )
  assert.ok(SCENARIO_ONLY_CHECKPOINTS.has('collaboration-space-deletion'))
  const defaults = DESKTOP_CHECKPOINTS.filter(id => !DESKTOP_CHECKPOINT_GROUPS.has(id))
  const shard = loadDesktopCheckpointCatalog().ci.core_shards[5].split(',')
  for (const id of ['collaboration-issue-archive', 'collaboration-space-deletion']) {
    assert.ok(defaults.includes(id), id)
    assert.ok(shard.includes(id), id)
  }
})

test('the existing CI profile checkpoint includes the original and model catalog regressions', () => {
  assert.deepEqual(expandDesktopCheckpoints(['stand-in-profile']), [
    'stand-in-profile-settings',
    'stand-in-model-catalog',
    'stand-in-processing',
    'coordination-runtime',
    'coordination-arrangements',
    'project-coordinator-publication',
    'project-coordination',
  ])
})

test('group expansion preserves ordering and runs each checkpoint once', () => {
  assert.deepEqual(
    expandDesktopCheckpoints(['stand-in-profile', 'stand-in-model-catalog', 'stand-in-controls']),
    [
      'stand-in-profile-settings',
      'stand-in-model-catalog',
      'stand-in-processing',
      'coordination-runtime',
      'coordination-arrangements',
      'project-coordinator-publication',
      'project-coordination',
      'stand-in-controls',
    ]
  )
})

test('the CI notification checkpoint preserves navigation and covers Issue read synchronization', () => {
  assert.deepEqual(expandDesktopCheckpoints(['collaboration-issue-comment-notification']), [
    'collaboration-issue-comment-notification-navigation',
    'issue-notification-read',
  ])
})

test('every group member is registered and no unknown checkpoint is silently discarded', () => {
  for (const members of DESKTOP_CHECKPOINT_GROUPS.values()) {
    for (const member of members) assert.ok(DESKTOP_CHECKPOINTS.includes(member), member)
  }
  assert.deepEqual(expandDesktopCheckpoints(['unknown']), ['unknown'])
})

test('Git connection checkpoint exposes the runner verification contract', async () => {
  assert.ok(DESKTOP_CHECKPOINTS.includes('stand-in-git'))
  const { createDesktopScenario } = await import('./scenarios/stand-in-git.scenario.mjs')
  const scenario = createDesktopScenario({ uiTimeoutMs: 10000, captureScreenshot: () => {} })
  assert.equal(typeof scenario.verify, 'function')
  assert.equal(scenario.requiresCloudEnvironment, true)
})
