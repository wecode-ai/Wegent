import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestRetryConfirmation } from './failed-upgrade-retry.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

/** Preserve the delivered source's quarantine or explicit consent instead of editing its history. */
export async function verifyRollbackProtection({
  control,
  root,
  target,
  preparedTarget,
  requests,
  about,
  route,
}) {
  assert.equal(preparedTarget.version, target.version)
  if (preparedTarget.packageSha256 !== undefined)
    assert.equal(preparedTarget.packageSha256, target.sha256)
  const readHistory = () => readProtectionHistory(root, target, preparedTarget)
  const history = await readHistory()
  const quarantinePath = join(root, 'rolled-back-versions.json')
  const quarantine = JSON.parse(await readFile(quarantinePath, 'utf8'))
  assert.ok(quarantine.includes(target.version), 'Rollback did not quarantine the target')
  const downloads = () => requests.filter(item => item.path === `/${target.name}`).length
  const before = downloads()
  await route()
  await about()
  await control.command('clickWhenEnabled', '[data-testid="about-check-update-button"]')
  const observed = await waitForValue(
    async () => ({
      progress: JSON.parse(await control.command('getAppUpdateProgress', 'body')),
      text: await control.command('getText', '[data-testid="about-update-status"]'),
    }),
    state =>
      Boolean(
        state.progress.update?.retryConfirmation ||
        /暂无已验证的升级路径|No verified upgrade path/.test(state.text)
      ),
    'The delivered source neither blocked the quarantined target nor required consent',
    DEFAULT_STEP_TIMEOUT_MS
  )
  const confirmation = observed.progress.update?.retryConfirmation
  if (confirmation) {
    const retry = await requestRetryConfirmation(control, target.version)
    assert.equal(retry.reason, 'rolled-back')
    assert.match(retry.token, /^[a-f0-9]{64}$/)
    await control.command('click', '[data-testid="app-update-retry-cancel"]')
    await control.command('waitFor', '[data-testid="app-update-retry-dialog"]', { visible: false })
  } else {
    assert.ok(!observed.progress.update, 'Quarantine still offered an update')
  }
  await control.command('waitFor', '[data-testid="about-check-update-button"]', {
    enabled: true,
    stableMs: 750,
  })
  const progress = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
  assert.equal(
    ['preparing', 'host', 'extracting', 'runtime', 'ready', 'installing'].includes(progress.phase),
    false
  )
  assert.equal(downloads(), before, 'The quarantined release downloaded without consent')
  assert.deepEqual(await readHistory(), history)
  assert.deepEqual(JSON.parse(await readFile(quarantinePath, 'utf8')), quarantine)
  return {
    version: target.version,
    packageSha256: target.sha256,
    kind: confirmation ? 'confirmation-required' : 'blocked',
    historyPreserved: true,
    downloadPrevented: true,
  }
}

async function readProtectionHistory(root, target, preparedTarget) {
  const history = JSON.parse(await readFile(join(root, 'update-rollback-history.json'), 'utf8'))
  assert.ok(Array.isArray(history), 'Rollback history must be a structured array')
  const record = history.find(
    item => item.version === target.version && item.reason === 'rolled-back'
  )
  assert.ok(record?.token, 'The actual rollback activation is missing')
  assert.ok(Number.isFinite(Date.parse(record.occurredAt)), 'Rollback time is missing')
  // Historical preparers omit this field; compare with their actual slot descriptor,
  // while the scenario independently verifies both immutable archives before launch.
  assert.equal(
    record.packageSha256,
    preparedTarget.packageSha256,
    'Rollback history differs from the source-prepared package identity'
  )
  return history
}
