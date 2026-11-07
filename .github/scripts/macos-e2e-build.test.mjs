import assert from 'node:assert/strict'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  archiveName,
  manifestName,
  artifactType,
  describeMacosBuild,
  verifyMacosBuild,
  macosSpecification,
} from './macos-e2e-build.mjs'
import {
  restoreVerifiedBuild,
  publishVerifiedBuild,
} from './verified-build-oci.mjs'
import {
  restoreMacosBuildFromCi,
  validateMacosBuildProducer,
} from './restore-macos-ci-build.mjs'

const sourceKey = 'a'.repeat(64)
const metadata = {
  sourceKey,
  image: `ghcr.io/wecode-ai/wegent-wework-macos-e2e-runtime:app-v1-${sourceKey}`,
}
const identity = {
  headSha: 'b'.repeat(40),
  runId: '123',
  repository: 'wecode-ai/Wegent',
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'macos-build-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'source')
  mkdirSync(directory)
  writeFileSync(
    join(directory, archiveName),
    'packaged App and native runtime archive',
  )
  describeMacosBuild(directory, metadata, identity)
  return { root, directory }
}

test('complete macOS reuse binds the same bytes to each producer and preserves the origin', (t) => {
  const { directory } = fixture(t)
  const next = { ...identity, headSha: 'c'.repeat(40), runId: '456' }
  const before = readFileSync(join(directory, archiveName))
  describeMacosBuild(directory, metadata, next)
  const manifest = verifyMacosBuild(directory, metadata, next)
  assert.deepEqual(manifest.origin, identity)
  assert.deepEqual(manifest.verifiedFor, next)
  assert.deepEqual(readFileSync(join(directory, archiveName)), before)
  assert.throws(
    () => verifyMacosBuild(directory, metadata, identity),
    /identity mismatch/,
  )
  assert.throws(
    () => verifyMacosBuild(directory, { sourceKey: 'd'.repeat(64) }),
    /input mismatch/,
  )
})

test('publication retains the tested upstream producer across a later consumer', (t) => {
  const { directory } = fixture(t)
  const source = {
    identity,
    job: 'https://github.com/wecode-ai/Wegent/actions/runs/123/job/789',
  }
  const publication = {
    headSha: 'c'.repeat(40),
    runId: '456',
    repository: 'wecode-ai/Wegent',
  }
  describeMacosBuild(directory, metadata, publication, source)
  describeMacosBuild(directory, metadata, { ...identity, runId: '999' })
  const manifest = verifyMacosBuild(directory, metadata)
  assert.deepEqual(manifest.validatedProducer, source)
  assert.deepEqual(manifest.origin, identity)
  manifest.validatedProducer.job =
    'https://github.com/other/repo/actions/runs/123/job/789'
  writeFileSync(join(directory, manifestName), JSON.stringify(manifest))
  assert.throws(() => verifyMacosBuild(directory, metadata))
})

for (const change of ['bytes', 'inventory', 'platform', 'kind', 'origin']) {
  test(`macOS verification rejects changed ${change}`, (t) => {
    const { directory } = fixture(t)
    const path = join(directory, manifestName)
    const manifest = JSON.parse(readFileSync(path))
    if (change === 'bytes')
      writeFileSync(join(directory, archiveName), 'corrupt')
    if (change === 'inventory') manifest.files.push(manifest.files[0])
    if (change === 'platform') manifest.context.platform = 'linux-x64'
    if (change === 'kind') manifest.kind = 'frontend-e2e'
    if (change === 'origin') manifest.origin.headSha = 'not-a-sha'
    writeFileSync(path, JSON.stringify(manifest))
    assert.throws(() => verifyMacosBuild(directory, metadata, identity))
  })
}

function registry(directory, mutate = () => {}) {
  const calls = []
  const run = (args, options) => {
    calls.push({ args, options })
    if (args[0] === 'manifest') {
      const manifest = {
        artifactType,
        layers: [archiveName, manifestName].map((name) => ({
          annotations: { 'org.opencontainers.image.title': name },
        })),
      }
      mutate(manifest)
      return JSON.stringify(manifest)
    }
    if (args[0] === 'pull') {
      const destination = args[args.indexOf('--output') + 1]
      for (const name of readdirSync(directory))
        copyFileSync(join(directory, name), join(destination, name))
      return ''
    }
    throw Error('Unexpected registry operation')
  }
  return { calls, run }
}

test('complete macOS OCI reuse enforces anonymous exact inventory before restoring', (t) => {
  const { root, directory } = fixture(t)
  const { calls, run } = registry(directory)
  const restored = join(root, 'restored')
  assert.equal(
    restoreVerifiedBuild(
      restored,
      metadata.image,
      macosSpecification(metadata),
      run,
    ),
    true,
  )
  verifyMacosBuild(restored, metadata, identity)
  assert(calls.every(({ args }) => args.includes('--registry-config')))
  for (const mutate of [
    (m) => {
      m.artifactType = 'wrong'
    },
    (m) => {
      m.layers.pop()
    },
    (m) => {
      m.layers.push(m.layers[0])
    },
  ]) {
    assert.throws(() =>
      restoreVerifiedBuild(
        join(root, 'bad'),
        metadata.image,
        macosSpecification(metadata),
        registry(directory, mutate).run,
      ),
    )
  }
  writeFileSync(join(directory, 'extra-file'), 'unexpected')
  assert.throws(
    () =>
      restoreVerifiedBuild(
        join(root, 'extra'),
        metadata.image,
        macosSpecification(metadata),
        run,
      ),
    /Unexpected macOS files/,
  )
})

test('immutable seed failures do not silently fall back to a compilation', (t) => {
  const { root } = fixture(t)
  const missing = () => {
    throw Object.assign(Error('not found'), { stderr: 'MANIFEST_UNKNOWN' })
  }
  const destination = join(root, 'absent')
  assert.equal(
    restoreVerifiedBuild(
      destination,
      metadata.image,
      macosSpecification(metadata),
      missing,
    ),
    false,
  )
  assert.throws(() =>
    restoreVerifiedBuild(
      destination,
      `${metadata.image.split(':app-v1-')[0]}@sha256:${sourceKey}`,
      macosSpecification(metadata),
      missing,
    ),
  )
  assert.throws(() =>
    restoreVerifiedBuild(
      destination,
      metadata.image,
      macosSpecification(metadata),
      () => {
        throw Error('connection reset')
      },
    ),
  )
})

test('existing complete builds are verified without being overwritten', (t) => {
  const { directory } = fixture(t)
  const { calls, run } = registry(directory)
  publishVerifiedBuild(
    directory,
    metadata.image,
    macosSpecification(metadata),
    run,
  )
  assert.equal(
    calls.some(({ args }) => args[0] === 'push'),
    false,
  )
})

const requiredSteps = [
  'Run Wework desktop macOS Inspector E2E',
  'Describe verified native macOS runtimes',
  'Upload verified macOS Executor runtime',
  'Upload verified macOS Backend runtime',
  'Archive verified complete macOS E2E build',
  'Upload verified complete macOS E2E build',
]
function producer() {
  const run = {
    id: 123,
    head_sha: identity.headSha,
    repository: { full_name: identity.repository },
    path: '.github/workflows/wework-e2e.yml',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
  }
  const job = {
    id: 789,
    run_id: 123,
    head_sha: run.head_sha,
    name: 'Wework Desktop macOS E2E',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/wecode-ai/Wegent/actions/runs/123/job/789',
    steps: requiredSteps.map((name) => ({ name, conclusion: 'success' })),
  }
  return { run, job }
}

test('promotion requires the exact successful Inspector, archive and upload producer', async (t) => {
  const { root, directory } = fixture(t)
  const { run, job } = producer()
  let downloads = 0
  const options = {
    json: async (path) => (path.includes('/jobs?') ? { jobs: [job] } : run),
    metadata: () => metadata,
    download: (_run, target) => {
      downloads++
      mkdirSync(target)
      for (const name of [archiveName, manifestName])
        copyFileSync(join(directory, name), join(target, name))
    },
  }
  const restored = await restoreMacosBuildFromCi(
    '123',
    join(root, 'promotion'),
    'wecode-ai',
    options,
  )
  assert.equal(restored.producer.sha, identity.headSha)
  assert.equal(downloads, 1)
  const dispatch = {
    ...run,
    event: 'workflow_dispatch',
    head_repository: { full_name: identity.repository },
  }
  assert.deepEqual(
    validateMacosBuildProducer(dispatch, [job]),
    restored.producer,
  )
  for (const head_repository of [{ full_name: 'fork/Wegent' }, undefined]) {
    assert.throws(() =>
      validateMacosBuildProducer({ ...dispatch, head_repository }, [job]),
    )
  }
  for (const name of requiredSteps) {
    const step = job.steps.find((step) => step.name === name)
    step.conclusion = 'skipped'
    assert.throws(() => validateMacosBuildProducer(run, [job]))
    step.conclusion = 'success'
  }
  for (const modify of [
    (r) => {
      r.repository.full_name = 'wrong/repo'
    },
    (r) => {
      r.path = '.github/workflows/wework-app.yml'
    },
    (r) => {
      r.event = 'schedule'
    },
    (r) => {
      r.status = 'in_progress'
    },
  ]) {
    const wrong = structuredClone(run)
    modify(wrong)
    assert.throws(() => validateMacosBuildProducer(wrong, [job]))
  }
  job.head_sha = 'c'.repeat(40)
  await assert.rejects(
    restoreMacosBuildFromCi(
      '123',
      join(root, 'bad-source'),
      'wecode-ai',
      options,
    ),
  )
  assert.equal(downloads, 1)
})
