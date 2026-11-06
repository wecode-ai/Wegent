import assert from 'node:assert/strict'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { waitForUpdatePreparation } from './update-preparation-progress.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

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
  await control.command('waitFor', autoUpdate)
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
  await control.command('navigate', 'body', { value: '/' })
  await control.command('clickWhenEnabled', '[data-testid="settings-button"]', { visible: true })
  await control.command('clickWhenEnabled', '[data-testid="app-update-error-details-button"]')
  const dialog = '[data-testid="app-update-error-dialog"]'
  const copyButton = '[data-testid="app-update-error-copy"]'
  await control.command('waitFor', dialog, { text: 'APP_UPDATE_DOWNLOAD_FAILED' })
  await control.command('pointerDown', copyButton)
  await control.command('waitFor', dialog)
  await control.command('clickWhenEnabled', copyButton)
  await control.command('waitFor', copyButton, { text: '已复制' })
  const diagnostics = await control.command('getClipboardText', 'body')
  assert.match(diagnostics, /APP_UPDATE_DOWNLOAD_FAILED/)
  assert.match(diagnostics, /HTTP 503/)
  await control.command('waitFor', dialog)
  const manifestPath = `/components-beta-${policy.platform}-${policy.arch}.json`
  const retryButton = '[data-testid="app-update-error-retry"]'
  const dialogRetryStart = requests.length
  await control.command('pointerDown', retryButton)
  await control.command('waitFor', dialog)
  await control.command('clickWhenEnabled', retryButton)
  await control.command('waitFor', dialog, { visible: false })
  // Observe this retry's transfer before reading progress, which previously held a failure.
  await waitForValue(
    async () => requests.slice(dialogRetryStart),
    current => current.includes('/unavailable-release.tar.gz'),
    'The error dialog retry did not start another release download',
    DEFAULT_STEP_TIMEOUT_MS
  )
  await assert.rejects(
    waitForUpdatePreparation(async () =>
      JSON.parse(await control.command('getAppUpdateProgress', 'body'))
    ),
    /Release download failed: HTTP 503/
  )
  const dialogRetryRequests = requests.slice(dialogRetryStart)
  assert.deepEqual(
    dialogRetryRequests,
    [manifestPath, '/unavailable-release.tar.gz'],
    'The error dialog retry must refresh the catalog and perform the advertised download'
  )
  await control.command('clickWhenEnabled', '[data-testid="about-menu-button"]', { visible: true })
  await control.command('waitFor', button, { visible: true, enabled: true })
  const requestCount = requests.length
  advertise(false)
  await control.command('clickWhenEnabled', button)
  await control.command('waitFor', '[data-testid="about-update-status"]', { text: '已是最新版本' })
  assert.deepEqual(
    requests.slice(requestCount),
    [manifestPath],
    'Retry must refresh the catalog without requesting the withdrawn archive'
  )
  const progress = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
  assert.equal(progress.phase, 'upToDate')
  assert.equal(progress.update, null)
  assert.equal(requests.filter(path => path === '/unavailable-release.tar.gz').length, 2)
  return {
    platform: process.platform,
    nativeClipboardVerified: true,
    dialogRetryRequests,
    phase: progress.phase,
    requests: requests.slice(requestCount),
  }
}
