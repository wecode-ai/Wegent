import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DESKTOP_CHECKPOINTS,
  DESKTOP_CHECKPOINT_CI_HOSTS,
  DESKTOP_CHECKPOINT_GROUPS,
  expandDesktopCheckpoints,
} from './checkpoints.mjs'
import { UPGRADE_CHECKPOINTS, UPGRADE_CHECKPOINT_GROUP } from './upgrade-suite.mjs'

test('Responses retains standalone selection and shares an existing CI Cloud lifecycle', () => {
  assert.deepEqual(expandDesktopCheckpoints(['responses-api-gateway']), ['responses-api-gateway'])
  assert.equal(DESKTOP_CHECKPOINT_CI_HOSTS.get('responses-api-gateway'), 'plugin-account-auth-dws')
  for (const [checkpoint, host] of DESKTOP_CHECKPOINT_CI_HOSTS) {
    assert.ok(DESKTOP_CHECKPOINTS.includes(checkpoint), checkpoint)
    assert.ok(DESKTOP_CHECKPOINTS.includes(host), host)
    assert.notEqual(checkpoint, host)
  }
})

test('upgrade verification has one maintained group for all supported operating systems', () => {
  assert.deepEqual(expandDesktopCheckpoints([UPGRADE_CHECKPOINT_GROUP]), UPGRADE_CHECKPOINTS)
  for (const checkpoint of UPGRADE_CHECKPOINTS) assert.ok(DESKTOP_CHECKPOINTS.includes(checkpoint))
})

test('the existing CI profile checkpoint includes the original and model catalog regressions', () => {
  assert.deepEqual(expandDesktopCheckpoints(['stand-in-profile']), [
    'stand-in-profile-settings',
    'stand-in-model-catalog',
  ])
})

test('group expansion preserves ordering and runs each checkpoint once', () => {
  assert.deepEqual(
    expandDesktopCheckpoints(['stand-in-profile', 'stand-in-model-catalog', 'stand-in-controls']),
    ['stand-in-profile-settings', 'stand-in-model-catalog', 'stand-in-controls']
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
