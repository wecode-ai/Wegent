import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { atomicReleaseWrite, ReleaseStore } from './release-store.js'
import { parseRollbackHistory, planUpdateRetry } from './release-update-history.js'
import type { UpgradeCatalog } from './upgrade-policy.mjs'

const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'update-history-'))
  directories.push(root)
  const store = new ReleaseStore(root)
  const release = (id: string, version: string) => ({
    schemaVersion: 1 as const,
    id,
    version,
    executable: join(root, id, 'host'),
    resources: join(root, id, 'resources'),
    profileRoot: join(root, id, 'profile'),
    runtimeRoot: join(root, id, 'runtimes'),
    dataSchema: 1,
    readableDataSchemas: [1],
    packageSha256: id === 'source' ? 'a'.repeat(64) : 'b'.repeat(64),
  })
  const source = release('source', '1.0.0')
  const target = release('target', '1.1.0')
  await store.save(source)
  await store.save(target)
  await atomicReleaseWrite(join(root, 'active'), source.id)
  await store.activate(target, 'snapshot')
  return { store, root, source, target, activation: (await store.activation())! }
}

test('startup rollback records the actual failed attempt and healthy confirmation clears it', async () => {
  const { store, root, target, activation } = await fixture()
  await atomicReleaseWrite(join(root, 'attempted'), activation.token)
  await atomicReleaseWrite(join(root, 'failed'), activation.token)
  await store.rollback()
  expect(await store.rollbackHistory()).toEqual([
    expect.objectContaining({
      token: activation.token,
      fromVersion: '1.0.0',
      version: target.version,
      packageSha256: target.packageSha256,
      reason: 'startup-failed',
    }),
  ])
  await store.activate(target, 'retry-snapshot')
  await store.confirm(target.id)
  expect(await store.rollbackHistory()).toEqual([])
})

test('manual rollback is distinguishable from a startup failure', async () => {
  const { store, target } = await fixture()
  await store.confirm(target.id)
  await store.requestRollback()
  await store.rollback()
  expect(await store.rollbackHistory()).toEqual([
    expect.objectContaining({ reason: 'rolled-back' }),
  ])
})

test('cancelling an unstarted activation does not quarantine a healthy version', async () => {
  const { store } = await fixture()
  await store.rollback()
  expect(await store.rollbackHistory()).toEqual([])
})

test('legacy rollback records remain retryable without inventing a startup failure', () => {
  expect(parseRollbackHistory(null, '["1.1.0"]')).toEqual([
    { token: 'legacy:1.1.0', version: '1.1.0', reason: 'legacy-rollback' },
  ])
  expect(() => parseRollbackHistory('[{"reason":"unknown"}]', null)).toThrow('history')
  expect(() => parseRollbackHistory(null, '[1]')).toThrow('quarantine')
})

function catalog(): UpgradeCatalog {
  const releases = ['1.0.0', '1.1.0', '1.2.0'].map((version, i) => ({
    version,
    minSourceVersion: '1.0.0',
    sha256: String(i).repeat(64),
    sourceSha: String(i).repeat(40),
    url: `https://example.com/${version}.tar.gz`,
    bytes: 7,
    dataSchema: 1,
    readableDataSchemas: [1],
    revoked: false,
  }))
  const edge = (from: number, to: number) => ({
    from: releases[from].version,
    to: releases[to].version,
    fromSha256: releases[from].sha256,
    toSha256: releases[to].sha256,
    fromSourceSha: releases[from].sourceSha,
    toSourceSha: releases[to].sourceSha,
    runId: '123',
    evidenceSha256: 'e'.repeat(64),
    upgrade: 'passed' as const,
    rollback: 'passed' as const,
    revoked: false,
  })
  return {
    schemaVersion: 1,
    channel: 'stable',
    platform: 'windows',
    arch: 'x64',
    releases,
    edges: [edge(0, 1), edge(1, 2)],
  }
}

test('a failed intermediate version requires consent instead of deadlocking the only path', () => {
  const result = planUpdateRetry(catalog(), '1.0.0', parseRollbackHistory(null, '["1.1.0"]'))
  expect(result.plan?.path).toEqual(['1.1.0', '1.2.0'])
  expect(result.retryConfirmation).toMatchObject({ version: '1.1.0', reason: 'legacy-rollback' })
})

test('a safe direct path avoids asking to retry an unused failed intermediate version', () => {
  const policy = catalog()
  policy.edges.push({
    ...policy.edges[1],
    from: '1.0.0',
    fromSha256: policy.releases[0].sha256,
    fromSourceSha: policy.releases[0].sourceSha,
  })
  const result = planUpdateRetry(policy, '1.0.0', parseRollbackHistory(null, '["1.1.0"]'))
  expect(result.plan?.path).toEqual(['1.2.0'])
  expect(result.retryConfirmation).toBeUndefined()
})

test('server-revoked edges cannot be offered for local retry', () => {
  const policy = catalog()
  policy.edges[0].revoked = true
  expect(planUpdateRetry(policy, '1.0.0', parseRollbackHistory(null, '["1.1.0"]')).plan).toBeNull()
})
