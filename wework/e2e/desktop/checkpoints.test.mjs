import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DESKTOP_CHECKPOINTS,
  DESKTOP_CHECKPOINT_CI_HOSTS,
  DESKTOP_CHECKPOINT_GROUPS,
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

test('source diagnostics use the shared package runner without certifying upgrade edges', () => {
  for (const checkpoint of ['app-update-refresh', 'app-update-retry']) {
    assert.ok(DESKTOP_CHECKPOINTS.includes(checkpoint))
    assert.ok(UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes(checkpoint))
    assert.equal(UPGRADE_PACKAGE_CHECKPOINTS.includes(checkpoint), false)
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
