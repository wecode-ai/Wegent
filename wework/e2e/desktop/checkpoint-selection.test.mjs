import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkpointLaunchArgs,
  checkpointRangeFrom,
  requestedCheckpointSelection,
} from './checkpoint-selection.mjs'
import { DESKTOP_CHECKPOINTS } from './checkpoints.mjs'

const defaults = ['alpha', 'telemetry-consent', 'telemetry-identity', 'omega']

test('a single segment resolves to that checkpoint', () => {
  assert.deepEqual(requestedCheckpointSelection(['--segment', 'omega'], defaults), {
    checkpoints: ['omega'],
    extraArgs: [],
  })
})

test('a segment range starts at the requested checkpoint and keeps later ones', () => {
  assert.deepEqual(
    requestedCheckpointSelection(['--from-segment', 'telemetry-identity'], defaults),
    {
      checkpoints: ['telemetry-identity', 'omega'],
      extraArgs: [],
    }
  )
})

test('scope flags survive range expansion instead of forcing a single run', () => {
  assert.deepEqual(
    requestedCheckpointSelection(
      ['--cloud-only', '--from-segment', 'telemetry-identity'],
      defaults
    ),
    {
      checkpoints: ['telemetry-identity', 'omega'],
      extraArgs: ['--cloud-only'],
    }
  )
})

test('an unknown range start is rejected instead of running everything', () => {
  assert.equal(requestedCheckpointSelection(['--from-segment', 'unknown'], defaults), null)
})

test('each checkpoint launches as its own segment with the forwarded flags', () => {
  assert.deepEqual(checkpointLaunchArgs('telemetry-identity', ['--cloud-only'], false), [
    '--segment',
    'telemetry-identity',
    '--cloud-only',
  ])
  assert.deepEqual(checkpointLaunchArgs('core-task-flow', [], true), [
    '--cloud-only',
    '--segment',
    'core-task-flow',
  ])
})

test('the telemetry identity checkpoint is part of the default range', () => {
  assert.ok(DESKTOP_CHECKPOINTS.includes('telemetry-identity'))
  assert.deepEqual(checkpointRangeFrom('telemetry-consent', DESKTOP_CHECKPOINTS).slice(0, 2), [
    'telemetry-consent',
    'telemetry-identity',
  ])
})
