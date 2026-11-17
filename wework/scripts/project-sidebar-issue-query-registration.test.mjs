import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CHECKPOINT_SCENARIO_MODULES,
  DESKTOP_CHECKPOINT_CI_HOSTS,
  expandDesktopCheckpoints,
} from '../e2e/desktop/checkpoints.mjs'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'

test('project Issue queries execute explicitly in the existing Core CI runners', () => {
  assert.equal(DESKTOP_CHECKPOINT_CI_HOSTS.has('project-sidebar-issue-query'), false)
  assert.equal(
    CHECKPOINT_SCENARIO_MODULES['project-sidebar-issue-query'],
    './scenarios/project-sidebar-issue-query.scenario.mjs'
  )
  const catalog = loadDesktopCheckpointCatalog()
  assert.ok(catalog.ci.core_segments.includes('project-sidebar-issue-query'))
  assert.ok(catalog.ci.core_shards[5].split(',').includes('project-sidebar-issue-query'))
  assert.deepEqual(
    catalog.PATH_TARGETS.get(
      'wework/e2e/desktop/scenarios/project-sidebar-issue-query.scenario.mjs'
    ),
    ['core:project-sidebar-issue-query']
  )
})

test('the real CI classifier emits the Issue query scenario as an executable matrix segment', () => {
  const output = execFileSync(
    'bash',
    [
      fileURLToPath(
        new URL('../../.github/scripts/classify-wework-desktop-e2e.sh', import.meta.url)
      ),
    ],
    {
      input: 'wework/e2e/desktop/scenarios/project-sidebar-issue-query.scenario.mjs\n',
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '/dev/stdout' },
    }
  )
  const matrixLine = output
    .split('\n')
    .find(line => line.startsWith('wework_desktop_core_e2e_matrix='))
  assert.ok(matrixLine, output)
  const matrix = JSON.parse(matrixLine.slice(matrixLine.indexOf('=') + 1))
  const executed = matrix.include.flatMap(row => expandDesktopCheckpoints(row.segments.split(',')))
  assert.ok(executed.includes('project-sidebar-issue-query'), JSON.stringify(matrix))
})

test('the classifier preserves complete stdout and appends identical GitHub output records', t => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-classifier-output-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const outputFile = join(directory, 'github output')
  const environment = { ...process.env }
  delete environment.GITHUB_OUTPUT
  const args = [
    fileURLToPath(new URL('../../.github/scripts/classify-wework-desktop-e2e.sh', import.meta.url)),
  ]
  const options = {
    input: 'wework/e2e/desktop/scenarios/project-sidebar-issue-query.scenario.mjs\n',
    encoding: 'utf8',
    env: environment,
  }
  const stdout = execFileSync('bash', args, options)
  const records = Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map(line => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1)]
      })
  )
  assert.deepEqual(Object.keys(records), [
    'wework_desktop_e2e',
    'wework_desktop_core_e2e',
    'wework_desktop_core_e2e_matrix',
    'wework_desktop_cloud_e2e',
    'wework_desktop_cloud_e2e_matrix',
    'wework_desktop_other_e2e',
    'wework_desktop_other_e2e_matrix',
    'wework_desktop_macos_inspector_e2e',
  ])
  for (const key of Object.keys(records).filter(key => key.endsWith('_matrix'))) {
    assert.ok(Array.isArray(JSON.parse(records[key]).include))
  }

  writeFileSync(outputFile, 'existing=value\n')
  assert.equal(
    execFileSync('bash', args, { ...options, env: { ...environment, GITHUB_OUTPUT: outputFile } }),
    ''
  )
  assert.equal(readFileSync(outputFile, 'utf8'), `existing=value\n${stdout}`)
})
