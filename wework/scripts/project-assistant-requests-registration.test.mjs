import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'

import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import { loadDesktopScenario } from '../e2e/desktop/scenario-loader.mjs'
import { createProjectAssistantSuite } from '../e2e/desktop/scenarios/project-assistant-requests-suite.scenario.mjs'

test('the registered request CI host enables durable assignment intake without changing legacy coverage', async () => {
  const catalog = loadDesktopCheckpointCatalog()
  const host = catalog.DESKTOP_CHECKPOINT_CI_HOSTS.get('multi-request-assistant-worktrees')
  assert.equal(host, 'project-assignment-notification')
  assert.equal(catalog.ci.core_segments.filter(id => id === host).length, 1)
  assert.equal(catalog.ci.core_segments.includes('multi-request-assistant-worktrees'), false)
  const load = id =>
    loadDesktopScenario(
      pathToFileURL(
        resolve(import.meta.dirname, '../e2e/desktop', catalog.CHECKPOINT_SCENARIO_MODULES[id])
      ).href,
      {}
    )
  const combined = await load(host)
  const standalone = await load('multi-request-assistant-worktrees')
  for (const scenario of [combined, standalone]) {
    assert.equal(scenario.backendEnv.HUMAN_ASSIGNMENT_RECEIPTS_ENABLED, 'true')
    assert.equal(scenario.backendEnv.ASYNC_ASSISTANT_REQUESTS_ENABLED, 'true')
  }
  const legacy = await load('stand-in-assignment-notifications')
  assert.equal(legacy.backendEnv?.HUMAN_ASSIGNMENT_RECEIPTS_ENABLED, undefined)
  assert.equal(legacy.backendEnv?.ASYNC_ASSISTANT_REQUESTS_ENABLED, undefined)
  assert.equal('asyncRequests' in legacy.diagnostics(), false)
  assert.deepEqual(
    catalog.PATH_TARGETS.get(
      'wework/e2e/desktop/scenarios/multi-request-assistant-worktrees.scenario.mjs'
    ),
    ['core:project-assignment-notification']
  )
  assert.deepEqual(
    catalog.PATH_TARGETS.get(
      'wework/e2e/desktop/scenarios/project-assignment-notification.scenario.mjs'
    ),
    ['core:project-assignment-notification']
  )
})

test('the shared host prepares both scenarios and routes model requests to the current verification', async () => {
  const events = []
  const cloud = {}
  const environment = {}
  const control = {}
  let suite
  const scenario = name => ({
    backendEnv: { [`${name}_ENABLED`]: 'true' },
    async prepareCloud(value) {
      assert.equal(value, cloud)
      events.push(`${name}:prepare`)
    },
    setCloudEnvironment(value) {
      assert.equal(value, environment)
      events.push(`${name}:environment`)
    },
    async handleHttp(...args) {
      assert.deepEqual(args, ['request', 'response', 'url'])
      events.push(`${name}:model`)
      return name
    },
    async verify(value) {
      assert.equal(value, control)
      events.push(`${name}:verify`)
      assert.equal(await suite.handleHttp('request', 'response', 'url'), name)
    },
    diagnostics: () => ({ name }),
    cleanup: () => events.push(`${name}:cleanup`),
  })
  suite = createProjectAssistantSuite(scenario('assignment'), scenario('requests'))
  assert.deepEqual(suite.backendEnv, { assignment_ENABLED: 'true', requests_ENABLED: 'true' })
  await suite.prepareCloud(cloud)
  suite.setCloudEnvironment(environment)
  await suite.verify(control)
  suite.cleanup()
  assert.deepEqual(events, [
    'assignment:prepare',
    'requests:prepare',
    'assignment:environment',
    'requests:environment',
    'assignment:verify',
    'assignment:model',
    'requests:verify',
    'requests:model',
    'requests:cleanup',
  ])
  assert.deepEqual(suite.diagnostics(), {
    assignment: { name: 'assignment' },
    asyncRequests: { name: 'requests' },
  })
})
