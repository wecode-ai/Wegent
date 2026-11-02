import assert from 'node:assert/strict'
import { waitForUpdatePreparation } from './update-preparation-progress.mjs'

// A deliberately unavailable offer exercises failure recovery without creating
// or modifying a release archive, or producing upgrade-edge evidence for it.
export function unavailableUpdatePolicy(packaged, target, origin) {
  const from = {
    version: packaged.appVersion,
    minSourceVersion: '0.0.0',
    sourceSha: packaged.sourceSha,
    sha256: '1'.repeat(64),
    bytes: 1,
    url: `${origin}/unavailable-release.tar.gz`,
    dataSchema: packaged.dataSchema,
    readableDataSchemas: packaged.readableDataSchemas,
    revoked: false,
  }
  const to = {
    ...from,
    version: `${Number(from.version.split('.')[0]) + 1}.0.0`,
    minSourceVersion: from.version,
    sha256: '2'.repeat(64),
  }
  return {
    schemaVersion: 1,
    channel: 'beta',
    ...target,
    releases: [from, to],
    edges: [
      {
        from: from.version,
        to: to.version,
        fromSha256: from.sha256,
        toSha256: to.sha256,
        fromSourceSha: from.sourceSha,
        toSourceSha: to.sourceSha,
        runId: String(process.env.GITHUB_RUN_ID || 1),
        evidenceSha256: 'a'.repeat(64),
        upgrade: 'passed',
        rollback: 'passed',
        revoked: false,
      },
    ],
  }
}

export async function verifyAppUpdateRetry(control, { policy, requests, advertise }) {
  await control.command('navigate', 'body', { value: '/settings/about' })
  const autoUpdate = '[data-testid="about-auto-update-switch"]'
  if ((await control.command('getAttribute', autoUpdate, { value: 'data-state' })) === 'checked')
    await control.command('click', autoUpdate)
  await control.command('waitFor', `${autoUpdate}[data-state="unchecked"]`)
  const beta = '[data-testid="about-beta-update-switch"]'
  assert.equal(await control.command('getAttribute', beta, { value: 'data-state' }), 'unchecked')
  advertise(true)
  await control.command('click', beta)
  await control.command('waitFor', `${beta}[data-state="checked"]`)
  const button = '[data-testid="about-check-update-button"]'
  await control.command('waitFor', '[data-testid="about-update-status"]', {
    text: policy.releases[1].version,
  })
  await control.command('clickWhenEnabled', button)
  await assert.rejects(
    waitForUpdatePreparation(async () =>
      JSON.parse(await control.command('getAppUpdateProgress', 'body'))
    ),
    /Release download failed: HTTP 503/
  )
  const requestCount = requests.length
  advertise(false)
  await control.command('clickWhenEnabled', button)
  await control.command('waitFor', '[data-testid="about-update-status"]', { text: '已是最新版本' })
  assert.deepEqual(
    requests.slice(requestCount),
    [`/components-beta-${policy.platform}-${policy.arch}.json`],
    'Retry must refresh the catalog without requesting the withdrawn archive'
  )
  const progress = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
  assert.equal(progress.phase, 'upToDate')
  assert.equal(progress.update, null)
  assert.equal(requests.filter(path => path === '/unavailable-release.tar.gz').length, 1)
  return { phase: progress.phase, requests: requests.slice(requestCount) }
}
