import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkpointScenarioEnv } from './checkpoint-environment.mjs'
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

test('Claude checkpoint enables native discovery only in its spawned child', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-checkpoint-env-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const probe = join(directory, 'probe.mjs')
  await writeFile(
    probe,
    'process.stdout.write(JSON.stringify({ toolSearch: process.env.ENABLE_TOOL_SEARCH, backgroundWindow: process.env.WEWORK_E2E_BACKGROUND_WINDOW }))\n'
  )
  const parentEnvironment = {
    ...process.env,
    ENABLE_TOOL_SEARCH: 'false',
    WEWORK_E2E_BACKGROUND_WINDOW: '1',
  }
  const parentSnapshot = JSON.stringify(parentEnvironment)
  const actualParentValue = process.env.ENABLE_TOOL_SEARCH
  const metadata = { scenarioModules: {}, scenarioOnlyCheckpoints: new Set() }
  for (const [checkpoint, expected, backgroundWindow] of [
    ['claude-runtime', 'true', '1'],
    ['python-runtime', 'false', '1'],
    ['core-task-flow', 'false', '0'],
    ['window-background-policy', 'false', '0'],
  ]) {
    const childEnvironment = checkpointScenarioEnv(parentEnvironment, checkpoint, metadata)
    const child = spawnSync(process.execPath, [probe], {
      encoding: 'utf8',
      env: childEnvironment,
    })
    assert.equal(child.error, undefined)
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(
      JSON.parse(child.stdout),
      { toolSearch: expected, backgroundWindow },
      checkpoint
    )
    assert.equal(
      JSON.stringify(parentEnvironment) === parentSnapshot,
      true,
      'Preparing a checkpoint must not mutate the parent environment'
    )
    assert.equal(process.env.ENABLE_TOOL_SEARCH, actualParentValue)
  }
})

test('checkpoint environments preserve package, focus, timezone and scenario contracts', () => {
  const parent = {
    WEWORK_E2E_APP_BIN: 'current-app',
    WEWORK_E2E_EXECUTOR_BIN: 'current-executor',
    WEWORK_E2E_UPGRADE_SOURCE_APP_BIN: 'source-app',
    WEWORK_E2E_UPGRADE_SOURCE_EXECUTOR_BIN: 'source-executor',
    WEWORK_E2E_DESKTOP_SCENARIO_MODULE: 'stale-module',
    WEWORK_E2E_DESKTOP_SCENARIO_ONLY: 'true',
    WEWORK_E2E_BACKGROUND_WINDOW: '1',
    TZ: 'UTC',
  }
  const metadata = {
    scenarioModules: { 'claude-runtime': './scenarios/claude-runtime.scenario.mjs' },
    scenarioOnlyCheckpoints: new Set(['claude-runtime']),
  }
  const upgrade = checkpointScenarioEnv(parent, UPGRADE_CHECKPOINTS[0], metadata)
  assert.equal(upgrade.WEWORK_E2E_APP_BIN, 'source-app')
  assert.equal(upgrade.WEWORK_E2E_EXECUTOR_BIN, 'source-executor')
  assert.equal(upgrade.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE, '1')
  const fallback = checkpointScenarioEnv(
    { WEWORK_E2E_APP_BIN: 'current-app', WEWORK_E2E_EXECUTOR_BIN: 'current-executor' },
    UPGRADE_CHECKPOINTS[0],
    metadata
  )
  assert.equal(fallback.WEWORK_E2E_APP_BIN, 'current-app')
  assert.equal(fallback.WEWORK_E2E_EXECUTOR_BIN, 'current-executor')
  const claude = checkpointScenarioEnv(parent, 'claude-runtime', metadata)
  assert.equal(
    claude.WEWORK_E2E_DESKTOP_SCENARIO_MODULE,
    metadata.scenarioModules['claude-runtime']
  )
  assert.equal(claude.WEWORK_E2E_DESKTOP_SCENARIO_ONLY, 'true')
  const ordinary = checkpointScenarioEnv(parent, 'core-task-flow', metadata)
  assert.equal(ordinary.WEWORK_E2E_BACKGROUND_WINDOW, '0')
  assert.equal(ordinary.WEWORK_E2E_DESKTOP_SCENARIO_MODULE, undefined)
  assert.equal(ordinary.WEWORK_E2E_DESKTOP_SCENARIO_ONLY, undefined)
  assert.equal(ordinary.TZ, 'UTC')
  assert.equal(
    checkpointScenarioEnv(parent, 'collaboration-shared-core', metadata).TZ,
    'Asia/Shanghai'
  )
  assert.equal(parent.WEWORK_E2E_BACKGROUND_WINDOW, '1')
  assert.equal(parent.TZ, 'UTC')
  assert.equal(parent.WEWORK_E2E_DESKTOP_SCENARIO_MODULE, 'stale-module')
})
