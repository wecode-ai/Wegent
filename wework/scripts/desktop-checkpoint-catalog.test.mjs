import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  buildDesktopCheckpointCatalog,
  loadDesktopCheckpointCatalog,
  readDesktopCheckpointDefinitions,
} from '../e2e/desktop/checkpoint-catalog.mjs'
import { expandDesktopCheckpoints } from '../e2e/desktop/checkpoints.mjs'
import { UPGRADE_CHECKPOINTS } from '../e2e/desktop/upgrade-suite.mjs'

const root = new URL('../../', import.meta.url)
const definitions = readDesktopCheckpointDefinitions()

test('Connector account isolation is selectable and runs inside the existing cloud OAuth checkpoint', () => {
  const catalog = loadDesktopCheckpointCatalog()
  assert.deepEqual(expandDesktopCheckpoints(['connector-account-switch']), [
    'connector-account-switch',
  ])
  assert.ok(catalog.DESKTOP_CHECKPOINTS.includes('connector-account-switch'))
  assert.equal(
    catalog.DESKTOP_CHECKPOINT_CI_HOSTS.get('connector-account-switch'),
    'connector-oauth'
  )
  assert.equal(
    catalog.CHECKPOINT_SCENARIO_MODULES['connector-account-switch'],
    './scenarios/connector-oauth.scenario.mjs'
  )
  assert.ok(catalog.CLOUD_ONLY_CHECKPOINTS.has('connector-account-switch'))
  assert.ok(catalog.ci.cloud_shards[7].split(',').includes('connector-oauth'))
  assert.equal(catalog.ci.cloud_segments.includes('connector-account-switch'), false)
  for (const path of [
    'wework/e2e/desktop/catalog/connector-account-switch.json',
    'wework/e2e/desktop/modules/connector-account-switch.mjs',
    'wework/e2e/desktop/modules/connector-oauth-provider.mjs',
  ]) {
    assert.ok(catalog.PATH_TARGETS.get(path)?.includes('cloud:connector-oauth'), path)
  }
})

test('every registered checkpoint retains a real module and a CI execution owner', () => {
  const catalog = loadDesktopCheckpointCatalog()
  const ciCheckpoints = expandDesktopCheckpoints([
    ...catalog.ci.core_segments,
    ...catalog.ci.cloud_segments,
    ...catalog.ci.formal_release_segments,
    ...UPGRADE_CHECKPOINTS,
  ])
  for (const id of catalog.DESKTOP_CHECKPOINTS) {
    if (catalog.DESKTOP_CHECKPOINT_GROUPS.has(id)) continue
    assert(ciCheckpoints.includes(catalog.DESKTOP_CHECKPOINT_CI_HOSTS.get(id) ?? id), id)
  }
  for (const [id, module] of Object.entries(catalog.CHECKPOINT_SCENARIO_MODULES)) {
    assert(existsSync(new URL(`../e2e/desktop/${module}`, import.meta.url)), `${id}: ${module}`)
  }
  for (const lane of ['core', 'cloud']) {
    const assigned = catalog.ci[`${lane}_shards`].flatMap(shard => shard.split(','))
    assert.deepEqual(assigned.toSorted(), catalog.ci[`${lane}_segments`].toSorted())
    assert.equal(new Set(assigned).size, assigned.length)
  }
})

test('independent new files register runner and CI metadata without editing shared lists', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-catalog-'))
  try {
    for (const id of ['new-feature-b', 'new-feature-a']) {
      writeFileSync(
        join(directory, `${id}.json`),
        JSON.stringify({
          order: 31001,
          scenario: `./scenarios/${id}.scenario.mjs`,
          scenarioOnly: true,
          paths: ['wework/src/features/new-feature/*'],
          ci: { core: { order: 38001, shard: 3, position: 9001 } },
        })
      )
    }
    const added = readDesktopCheckpointDefinitions(pathToFileURL(`${directory}/`))
    const catalog = buildDesktopCheckpointCatalog([...definitions, ...added])
    assert.deepEqual(
      catalog.DESKTOP_CHECKPOINTS.filter(id => id.startsWith('new-feature-')),
      ['new-feature-a', 'new-feature-b']
    )
    assert.equal(
      catalog.CHECKPOINT_SCENARIO_MODULES['new-feature-a'],
      './scenarios/new-feature-a.scenario.mjs'
    )
    assert(catalog.SCENARIO_ONLY_CHECKPOINTS.has('new-feature-b'))
    assert.match(
      catalog.ci.core_shards[2],
      /stand-in-email,new-feature-a,new-feature-b,stand-in-list-confirmation/
    )
    assert.deepEqual(
      catalog.PATH_TARGETS.get('wework/e2e/desktop/scenarios/new-feature-a.scenario.mjs'),
      ['core:new-feature-a']
    )
    assert.deepEqual(catalog.ADDITIONAL_PATH_TARGETS.get('wework/src/features/new-feature/*'), [
      'core:new-feature-a',
      'core:new-feature-b',
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('invalid metadata fails instead of silently omitting coverage', () => {
  const mutations = [
    [entries => entries.push(entries[0]), /duplicate desktop checkpoint/],
    [
      entries => {
        entries[0].scenarioOnly = 'true'
      },
      /Invalid checkpoint flag/,
    ],
    [
      entries => {
        entries[0].typo = true
      },
      /Unknown checkpoint field/,
    ],
    [
      entries => {
        entries[0].members = ['missing-checkpoint']
      },
      /Unknown checkpoint reference/,
    ],
    [
      entries => {
        entries.find(entry => entry.id === 'stand-in-email').ci.core.shard = 0
      },
      /Core segment missing/,
    ],
    [
      entries => {
        entries[0].ci = { typo: { order: 1 } }
      },
      /Unknown CI lane/,
    ],
    [
      entries => {
        entries[0].order = NaN
      },
      /Invalid checkpoint order/,
    ],
  ]
  for (const [mutate, message] of mutations) {
    const entries = structuredClone(definitions)
    mutate(entries)
    assert.throws(() => buildDesktopCheckpointCatalog(entries), message)
  }
})

test('a child config selects its composite CI owner and hosted checkpoints select their host', () => {
  const catalog = loadDesktopCheckpointCatalog()
  assert.deepEqual(
    catalog.PATH_TARGETS.get('wework/e2e/desktop/catalog/stand-in-profile-settings.json'),
    ['core:stand-in-profile']
  )
  assert.deepEqual(
    catalog.PATH_TARGETS.get('wework/e2e/desktop/catalog/responses-api-gateway.json'),
    ['cloud:plugin-account-auth-dws']
  )
})

function classified(path, script = '.github/scripts/classify-wework-desktop-e2e.sh') {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-classifier-'))
  try {
    // Match GitHub's file-based output protocol; child stdout can be a socket.
    const outputFile = join(directory, 'github-output')
    execFileSync('bash', [script, path], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
      encoding: 'utf8',
    })
    return Object.fromEntries(
      readFileSync(outputFile, 'utf8')
        .trim()
        .split('\n')
        .map(line => {
          const separator = line.indexOf('=')
          return [line.slice(0, separator), line.slice(separator + 1)]
        })
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a feature config selects its existing shard rather than all desktop suites', () => {
  const result = classified('wework/e2e/desktop/catalog/stand-in-email.json')
  assert.deepEqual(JSON.parse(result.wework_desktop_core_e2e_matrix), {
    include: [{ id: 'core-3', name: 'Core / shard 3', segments: 'stand-in-email' }],
  })
  assert.equal(result.wework_desktop_cloud_e2e, 'false')
  assert.equal(result.wework_desktop_other_e2e, 'false')
})

test('Connector fixture and standalone checkpoint edits select only their existing cloud host', () => {
  for (const path of [
    'wework/e2e/desktop/catalog/connector-account-switch.json',
    'wework/e2e/desktop/modules/connector-account-switch.mjs',
    'wework/e2e/desktop/modules/connector-oauth-provider.mjs',
  ]) {
    const result = classified(path)
    assert.deepEqual(JSON.parse(result.wework_desktop_cloud_e2e_matrix), {
      include: [{ id: 'cloud-8', name: 'Cloud / shard 8', segments: 'connector-oauth' }],
    })
    assert.equal(result.wework_desktop_core_e2e, 'false')
    assert.equal(result.wework_desktop_other_e2e, 'false')
  }
})

test('theme changes select the gallery and real content and auxiliary window regressions', () => {
  const result = classified('wework/src/features/appearance/ThemeSelector.tsx')
  const checkpoints = JSON.parse(result.wework_desktop_core_e2e_matrix).include.flatMap(shard =>
    shard.segments.split(',')
  )
  for (const id of [
    'appearance-themes',
    'application-menu',
    'background-terminals',
    'collaboration-first-use',
    'local-file-preview',
    'office-file-preview',
    'streaming-content',
  ]) {
    assert.ok(checkpoints.includes(id), `Theme changes omit the ${id} CI checkpoint`)
  }
})

test('extracted routing and test modules retain their parent CI gates', () => {
  for (const path of [
    '.github/scripts/desktop-ci/workbench-paths.sh',
    '.github/scripts/ci-classification-tests/new-feature.sh',
  ]) {
    const desktop = classified(path)
    assert.equal(JSON.parse(desktop.wework_desktop_core_e2e_matrix).include.length, 10)
    assert.equal(JSON.parse(desktop.wework_desktop_cloud_e2e_matrix).include.length, 8)
    const modules = classified(path, '.github/scripts/classify-ci-changes.sh')
    assert.equal(modules.wework_e2e, 'true')
  }
})
