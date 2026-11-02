import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { expandDesktopCheckpoints } from '../../wework/e2e/desktop/checkpoints.mjs'
import { orderLinuxCheckpoints } from './order-wework-linux-e2e.mjs'

const root = new URL('../../', import.meta.url)
const measurements = JSON.parse(
  readFileSync(
    new URL('../ci/wework-linux-checkpoint-durations.json', import.meta.url),
    'utf8',
  ),
)
function readYaml(path) {
  return JSON.parse(
    execFileSync(
      'ruby',
      [
        '-ryaml',
        '-rjson',
        '-e',
        'puts JSON.generate(YAML.load_file(ARGV[0]))',
        path,
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  )
}

const workflow = readYaml('.github/workflows/wework-e2e.yml')

function classifiedMatrices(
  paths,
  script = '.github/scripts/classify-wework-desktop-e2e.sh',
) {
  const directory = mkdtempSync(join(tmpdir(), 'wework-linux-order-'))
  try {
    const output = join(directory, 'github-output')
    execFileSync('bash', [script, ...(paths ? [] : ['--all'])], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: output },
      input: paths ? `${paths.join('\n')}\n` : undefined,
    })
    return Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const index = line.indexOf('=')
          return [line.slice(0, index), line.slice(index + 1)]
        }),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const matrices = classifiedMatrices()

test('changes to Linux scheduling or MinIO setup select the existing desktop suites', () => {
  for (const path of [
    '.github/ci/wework-linux-checkpoint-durations.json',
    '.github/scripts/order-wework-linux-e2e.mjs',
    '.github/scripts/order-wework-linux-e2e.test.mjs',
    '.github/actions/setup-minio-e2e/action.yml',
    '.github/actions/build-minio-e2e/action.yml',
  ]) {
    const outputs = classifiedMatrices([path])
    assert.deepEqual(outputs, matrices, path)
    const result = classifiedMatrices(
      [path],
      '.github/scripts/classify-ci-changes.sh',
    )
    assert.equal(result.wework_e2e, 'true', path)
  }
})

function completionSeconds(checkpoints, seconds) {
  const workers = Array(measurements.workers).fill(0)
  for (const checkpoint of checkpoints) {
    assert.ok(seconds[checkpoint] > 0, checkpoint)
    const index = workers.indexOf(Math.min(...workers))
    workers[index] += seconds[checkpoint]
  }
  return Math.max(...workers)
}

test('ordering preserves every selected checkpoint in its existing shard and runner budget', () => {
  for (const [scope, count] of [
    ['core', 10],
    ['cloud', 8],
  ]) {
    const matrix = JSON.parse(matrices[`wework_desktop_${scope}_e2e_matrix`])
    assert.equal(matrix.include.length, count)
    for (const shard of matrix.include) {
      const segments = shard.segments.split(',')
      const original = expandDesktopCheckpoints(segments)
      const ordered = orderLinuxCheckpoints(segments, scope)
      assert.deepEqual([...ordered].sort(), [...original].sort(), shard.id)
      assert.equal(new Set(ordered).size, original.length, shard.id)
      assert.deepEqual(orderLinuxCheckpoints(segments, scope), ordered)
      assert.deepEqual(
        segments,
        shard.segments.split(','),
        'Do not mutate the classifier matrix',
      )
    }
    const job = workflow.jobs[`wework-desktop-${scope}-e2e`]
    const run = job.steps.find(
      (step) =>
        step.name ===
        (scope === 'core'
          ? 'Run Wework desktop Core shard E2E'
          : 'Run Wework desktop Cloud E2E checkpoints'),
    )
    assert.equal(run.env.WEWORK_E2E_PARALLEL_CHECKPOINTS, '4')
    assert.match(
      run.run,
      /WEWORK_E2E_SEGMENTS="\$\(node \.github\/scripts\/order-wework-linux-e2e\.mjs\)"/,
    )
    assert.match(run.run, /--parallel-segments "\$WEWORK_E2E_SEGMENTS"/)
    assert.equal(
      job.strategy.matrix,
      '${{ fromJSON(needs.changes.outputs.wework_desktop_' +
        scope +
        '_e2e_matrix) }}',
    )
    assert.equal(job.strategy['max-parallel'], scope === 'core' ? 17 : 15)
  }
  const windows = workflow.jobs['wework-desktop-windows-core-e2e']
  assert.ok(!JSON.stringify(windows).includes('order-wework-linux-e2e'))
})

test('successful Linux timing replay starts long tail checkpoints first with the same four workers', () => {
  for (const [scope, id, longest] of [
    ['core', 'core-6', 'running-conversation-history'],
    ['cloud', 'cloud-3', 'plugin-write-coordination'],
  ]) {
    const matrix = JSON.parse(matrices[`wework_desktop_${scope}_e2e_matrix`])
    const shard = matrix.include.find((entry) => entry.id === id)
    assert.ok(shard, id)
    const segments = shard.segments.split(',')
    const ordered = orderLinuxCheckpoints(segments, scope)
    assert.equal(ordered[0], longest)
    const originalSeconds = completionSeconds(
      expandDesktopCheckpoints(segments),
      measurements.scopes[scope],
    )
    const orderedSeconds = completionSeconds(
      ordered,
      measurements.scopes[scope],
    )
    assert.ok(
      orderedSeconds < originalSeconds,
      `${id}: ${orderedSeconds} < ${originalSeconds}`,
    )
  }
})

test('unmeasured and equal-duration checkpoints retain stable priority without dropping new coverage', () => {
  const selected = [
    'running-sidebar-state',
    'running-conversation-history',
    'task-board-association',
    'local-file-preview',
  ]
  assert.deepEqual(orderLinuxCheckpoints(selected, 'core', {}), selected)
  assert.deepEqual(
    orderLinuxCheckpoints(selected, 'core', {
      'running-sidebar-state': 20,
      'running-conversation-history': 480,
      'local-file-preview': 20,
    }),
    [
      'task-board-association',
      'running-conversation-history',
      'running-sidebar-state',
      'local-file-preview',
    ],
  )
  assert.deepEqual(orderLinuxCheckpoints([], 'core'), [])
  assert.throws(
    () => orderLinuxCheckpoints(selected, 'windows'),
    /Unknown Linux E2E scope/,
  )
  assert.throws(
    () => orderLinuxCheckpoints(['missing-checkpoint'], 'core'),
    /Unknown desktop E2E checkpoint/,
  )
  assert.throws(
    () => orderLinuxCheckpoints(selected, 'core', { 'local-file-preview': 0 }),
    /Invalid Linux E2E duration/,
  )
})

test('the CI command expands selected groups and fails on invalid input', () => {
  const selected = ['stand-in-profile', 'running-conversation-history']
  const env = {
    ...process.env,
    WEWORK_E2E_PARALLEL_SCOPE: 'core',
    WEWORK_E2E_SEGMENTS: selected.join(','),
  }
  const result = spawnSync(
    process.execPath,
    ['.github/scripts/order-wework-linux-e2e.mjs'],
    { cwd: root, env, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    result.stdout.trim().split(','),
    orderLinuxCheckpoints(selected, 'core'),
  )
  const invalid = spawnSync(
    process.execPath,
    ['.github/scripts/order-wework-linux-e2e.mjs'],
    { cwd: root, env: { ...env, WEWORK_E2E_SEGMENTS: '' }, encoding: 'utf8' },
  )
  assert.notEqual(invalid.status, 0)
})

test('MinIO setup uses the shared artifact binary and fails closed when it is missing or unusable', () => {
  const action = readYaml('.github/actions/setup-minio-e2e/action.yml')
  const steps = action.runs.steps
  assert.equal(
    steps.length,
    2,
    'No runner-local Go compiler or dependency cache setup',
  )
  assert.match(steps[0].uses, /^actions\/download-artifact@/)
  const directory = mkdtempSync(join(tmpdir(), 'wework-minio-artifact-'))
  try {
    const binary = join(directory, 'minio')
    const output = join(directory, 'github-env')
    const env = {
      ...process.env,
      WEWORK_E2E_MINIO_BIN: binary,
      GITHUB_ENV: output,
    }
    const setup = (values) =>
      spawnSync('bash', ['-e', '-o', 'pipefail', '-c', steps[1].run], {
        env: values,
        encoding: 'utf8',
      })
    assert.notEqual(setup({ ...env, WEWORK_E2E_MINIO_BIN: '' }).status, 0)
    assert.notEqual(setup(env).status, 0)
    writeFileSync(binary, '#!/bin/sh\nexit 1\n')
    chmodSync(binary, 0o755)
    assert.notEqual(setup(env).status, 0)
    writeFileSync(binary, '#!/bin/sh\n[ "$1" = "--version" ]\n')
    chmodSync(binary, 0o644)
    const enabled = setup(env)
    assert.equal(enabled.status, 0, enabled.stderr)
    assert.equal(
      statSync(binary).mode & 0o777,
      0o755,
      'Artifact downloads must restore execute permissions',
    )
    assert.equal(
      readFileSync(output, 'utf8'),
      `WEWORK_E2E_MINIO_BIN=${binary}\n`,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  const build = readFileSync(
    new URL('../actions/build-minio-e2e/action.yml', import.meta.url),
    'utf8',
  )
  assert.match(build, /go-version: "1\.25\.9"/)
  assert.match(
    build,
    /go install github\.com\/minio\/minio@9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/,
  )
})

test('one existing producer builds MinIO for exactly the consumers that need it without GHCR writes', () => {
  const producers = Object.entries(workflow.jobs).flatMap(([job, value]) =>
    value.steps
      .filter((step) => step.uses === './.github/actions/build-minio-e2e')
      .map((step) => ({ job, step })),
  )
  assert.equal(producers.length, 1)
  assert.equal(producers[0].job, 'build-wework-desktop-core-e2e')
  const required = []
  for (const scope of ['core', 'cloud']) {
    const consumer = workflow.jobs[`wework-desktop-${scope}-e2e`]
    const setup = consumer.steps.find(
      (step) => step.uses === './.github/actions/setup-minio-e2e',
    )
    assert.ok(setup)
    assert.ok(consumer.needs.includes(producers[0].job))
    for (const match of setup.if.matchAll(
      /contains\(matrix.segments, '([^']+)'\)/g,
    )) {
      required.push({ scope, segment: match[1] })
    }
  }
  assert.equal(required.length, 6)
  const evaluate = new Function(
    'needs',
    'contains',
    `return ${producers[0].step.if}`,
  )
  for (const selection of [
    ...required,
    { scope: 'core', segment: 'split-workbench' },
    null,
  ]) {
    const outputs = Object.fromEntries(
      ['core', 'cloud'].map((scope) => [
        `wework_desktop_${scope}_e2e_matrix`,
        JSON.stringify({
          include:
            selection?.scope === scope ? [{ segments: selection.segment }] : [],
        }),
      ]),
    )
    assert.equal(
      evaluate({ changes: { outputs } }, (source, value) =>
        source.includes(value),
      ),
      required.includes(selection),
    )
  }
  const build = readYaml('.github/actions/build-minio-e2e/action.yml').runs
    .steps
  assert.ok(build.every((step) => !step.uses?.startsWith('docker/')))
  assert.equal(
    build.find((step) => step.name === 'Set up Go for real object storage')
      .with['go-version'],
    '1.25.9',
  )
  const upload = build.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  )
  const download = readYaml('.github/actions/setup-minio-e2e/action.yml').runs
    .steps[0]
  assert.equal(upload.with.name, download.with.name)
  assert.equal(upload.with['if-no-files-found'], 'error')
  assert.equal(upload.with.path, '${{ runner.temp }}/wework-minio/bin/minio')
  assert.equal(download.with.path, '${{ runner.temp }}/wework-minio/bin')
})

test('timing evidence and scheduling regression tests are bound to CI', () => {
  assert.match(
    measurements.run,
    /^https:\/\/github.com\/wecode-ai\/Wegent\/actions\/runs\/\d+$/,
  )
  assert.match(measurements.headSha, /^[a-f0-9]{40}$/)
  assert.equal(measurements.workers, 4)
  for (const seconds of Object.values(measurements.scopes).flatMap((scope) =>
    Object.values(scope),
  )) {
    assert.ok(Number.isFinite(seconds) && seconds > 0)
  }
  const lint = readFileSync(
    new URL('../workflows/lint.yml', import.meta.url),
    'utf8',
  )
  assert.match(
    lint,
    /node --test .*\.github\/scripts\/order-wework-linux-e2e\.test\.mjs/,
  )
})
