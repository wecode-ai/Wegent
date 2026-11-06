import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readRollbackHistory } from '../e2e/desktop/modules/failed-upgrade-retry.mjs'

test('retry verification requires the real package identity and production failure reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-retry-evidence-'))
  const target = { version: '1.1.0', sha256: 'a'.repeat(64) }
  const history = [
    {
      token: 'real-activation-token',
      version: target.version,
      fromVersion: '1.0.0',
      packageSha256: target.sha256,
      reason: 'startup-failed',
      occurredAt: new Date().toISOString(),
    },
  ]
  try {
    await assert.rejects(readRollbackHistory(root, target, 'startup-failed'), /rebuild the source/)
    await writeFile(join(root, 'rolled-back-versions.json'), JSON.stringify([target.version]))
    await assert.rejects(readRollbackHistory(root, target, 'startup-failed'), /rebuild the source/)
    await writeFile(join(root, 'update-rollback-history.json'), JSON.stringify(history))
    assert.deepEqual(await readRollbackHistory(root, target, 'startup-failed'), history)
    await assert.rejects(readRollbackHistory(root, target, 'rolled-back'), /did not record/)
    await assert.rejects(
      readRollbackHistory(root, { ...target, sha256: 'b'.repeat(64) }, 'startup-failed'),
      /another package/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
