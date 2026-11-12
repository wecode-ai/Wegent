import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  selectedPrefetchSources,
  prefetchUpgradeSources,
  prefetchSelectedSources,
  startUpgradeSourcePrefetch,
  waitForUpgradeSourcePrefetch,
} from './lib/upgrade-source-prefetch.mjs'
import { planUpgradeShards } from './lib/upgrade-verification-shards.mjs'

async function fixture(t, platform = 'windows', currentPolicy = false) {
  const arch = platform === 'windows' ? 'x64' : 'arm64'
  const directory = await mkdtemp(join(tmpdir(), 'wework-prefetch-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const policy = currentPolicy
    ? JSON.parse(await readFile(new URL('../upgrade-policy.json', import.meta.url), 'utf8'))
    : { schemaVersion: 1, minSourceVersion: '0.6.2' }
  const major = Number(policy.minSourceVersion.split('.')[0]) + 1
  const versions = currentPolicy
    ? [`${major}.0.0`, `${major}.0.1`, `${major}.0.2`]
    : ['0.6.2', '0.6.3', '0.6.4']
  const release = version => ({
    version,
    url: `https://example.com/${version}.tar.gz`,
    minSourceVersion: versions[0],
    sha256: 'a'.repeat(64),
    sourceSha: 'b'.repeat(40),
    bytes: 42,
    dataSchema: 1,
    readableDataSchemas: [1],
    revoked: false,
  })
  const catalog = channel => ({
    schemaVersion: 1,
    channel,
    platform,
    arch,
    releases: versions.slice(0, 2).map(release),
    edges: [],
  })
  const options = {
    directory: join(directory, 'worker'),
    planDirectory: join(directory, 'plans'),
    platform,
    arch,
    version: versions[2],
    releaseChannel: 'stable',
    channel: 'stable',
    sourceVersion: versions[0],
    repository: 'wecode-ai/Wegent',
  }
  const frozen = planUpgradeShards({
    catalogs: { stable: catalog('stable'), beta: catalog('beta') },
    version: options.version,
    channel: options.releaseChannel,
    policy,
    platform: options.platform,
    arch: options.arch,
  })
  await mkdir(options.planDirectory)
  await writeFile(join(options.planDirectory, `${platform}-${arch}.json`), JSON.stringify(frozen))
  return { options, frozen }
}

test('prefetch selects exactly the frozen source and required legacy activation input', async t => {
  const windows = await fixture(t)
  assert.deepEqual(
    selectedPrefetchSources(windows.frozen, windows.options).map(source => source.version),
    ['0.6.2']
  )
  const { options, frozen } = await fixture(t, 'macos')
  assert.deepEqual(
    selectedPrefetchSources(frozen, options).map(source => source.version),
    ['0.6.2', '0.6.3']
  )
  assert.deepEqual(
    selectedPrefetchSources(frozen, { ...options, sourceVersion: '0.6.3' }).map(
      source => source.version
    ),
    ['0.6.3']
  )
  assert.throws(() => selectedPrefetchSources(frozen, { ...options, sourceVersion: 'unselected' }))
  const active = new Set()
  let peak = 0
  await prefetchSelectedSources(frozen, options, async input => {
    assert.equal(input.expected.sha256, 'a'.repeat(64))
    assert.equal(input.directory, join(options.directory, input.version))
    active.add(input.version)
    peak = Math.max(peak, active.size)
    await new Promise(accept => setImmediate(accept))
    active.delete(input.version)
  })
  assert.equal(peak, 2)
})

test('settles every input before propagating failures and rejects a changed plan', async t => {
  const legacy = await fixture(t, 'macos')
  let settled = false
  await assert.rejects(
    prefetchSelectedSources(legacy.frozen, legacy.options, async source => {
      if (source.version === '0.6.2') throw new Error('archive hash differs')
      await new Promise(accept => setImmediate(accept))
      settled = true
    }),
    /archive hash differs/
  )
  assert.equal(settled, true)
  const { options, frozen } = await fixture(t, 'macos', true)
  let downloaded = 0
  await prefetchUpgradeSources(options, async () => {
    downloaded++
  })
  assert.equal(downloaded, 1)
  frozen.version = '0.6.5'
  await writeFile(
    join(options.planDirectory, `${options.platform}-${options.arch}.json`),
    JSON.stringify(frozen)
  )
  await assert.rejects(
    prefetchUpgradeSources(options, () => assert.fail('download before plan verification')),
    /Frozen upgrade plan/
  )
})

test('detached worker reports a real preparation error to the consuming step', async t => {
  const { options } = await fixture(t, 'windows', true)
  await startUpgradeSourcePrefetch({ ...options, sourceVersion: 'unselected' })
  await assert.rejects(
    waitForUpgradeSourcePrefetch(options.directory, 5000),
    /Historical input prefetch failed/
  )
  const worker = JSON.parse(await readFile(join(options.directory, 'worker.json'), 'utf8'))
  assert.ok(worker.pid > 0)
})
