import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DESKTOP_CHECKPOINTS,
  DESKTOP_CHECKPOINT_GROUPS,
  expandDesktopCheckpoints,
} from './checkpoints.mjs'
import { UPGRADE_CHECKPOINTS, UPGRADE_CHECKPOINT_GROUP } from './upgrade-suite.mjs'

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

test('every group member is registered and no unknown checkpoint is silently discarded', () => {
  for (const members of DESKTOP_CHECKPOINT_GROUPS.values()) {
    for (const member of members) assert.ok(DESKTOP_CHECKPOINTS.includes(member), member)
  }
  assert.deepEqual(expandDesktopCheckpoints(['unknown']), ['unknown'])
})
