import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  INSTALLATION_ID,
  SMART_APP_ALT_ICON_DATA_URL,
  SMART_APP_ALT_SCREENSHOT_DATA_URL,
  SMART_APP_ICON_DATA_URL,
  SMART_APP_SCREENSHOT_DATA_URL,
  waitForMissing,
} from './harness-app-fixture.mjs'

export async function verifySmartAppAssetInheritance(
  control,
  { ownerRequest, backendUrl, authToken, smartAppId, packages, uiTimeoutMs, captureScreenshot }
) {
  assert.ok(smartAppId, 'Shared Smart app fixture did not expose its catalog ID')
  assert.ok(packages, 'Smart app lifecycle publication fixtures were not prepared')
  const client = { ownerRequest, backendUrl, authToken }
  const inheritedIcon = SMART_APP_ICON_DATA_URL
  const inheritedScreenshots = [SMART_APP_SCREENSHOT_DATA_URL]

  const seeded = await publishSmartAppVersion(client, {
    packagePath: packages.seedAssets,
    smartAppId,
    version: '0.0.10',
    iconDataUrl: inheritedIcon,
    screenshotDataUrls: inheritedScreenshots,
    releaseNotes: 'Seed existing marketplace images',
  })
  assert.equal(seeded.version, '0.0.10')
  await assertSmartAppAssetDigests(seeded, {
    iconDataUrl: inheritedIcon,
    screenshotDataUrls: inheritedScreenshots,
    message: 'Seeding marketplace images',
  })

  await control.command('navigate', 'body', { value: '/sites' })
  await control.command('waitFor', '[data-testid="sites-workspace"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('navigate', 'body', { value: '/sites?app_type=smart_app&view=owned' })
  await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command(
    'clickWhenEnabled',
    `[data-testid="smart-app-created-publish-${INSTALLATION_ID}"]`,
    { timeoutMs: uiTimeoutMs }
  )
  await control.command('waitFor', '[data-testid="smart-app-publish-dialog"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-app-publish-current-icon"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-app-publish-current-screenshot-0"]', {
    timeoutMs: uiTimeoutMs,
  })
  const publishDialogText = await control.command(
    'getText',
    '[data-testid="smart-app-publish-dialog"]'
  )
  assert.ok(
    publishDialogText.includes('不重新选择时，将沿用当前图标和截图。'),
    'Smart app publish dialog did not explain marketplace image inheritance'
  )
  assert.ok(
    publishDialogText.includes('沿用当前图标'),
    'Smart app publish dialog did not show the inherited icon state'
  )
  assert.ok(
    publishDialogText.includes('沿用当前 1 张截图'),
    'Smart app publish dialog did not show the inherited screenshot state'
  )
  await captureScreenshot(control, 'harness-apps-05b-publish-inherit-assets.png', 'body')
  await control.command('clickWhenEnabled', '[data-testid="smart-app-publish-submit"]', {
    timeoutMs: uiTimeoutMs,
  })
  await waitForMissing(control, '[data-testid="smart-app-publish-dialog"]', 120_000)
  // The imported installation fixture publishes its manifest version, 0.1.0.
  const uiPublished = await waitForSmartAppVersion(ownerRequest, smartAppId, '0.1.0', 120_000)
  await assertSmartAppAssetDigests(uiPublished, {
    iconDataUrl: inheritedIcon,
    screenshotDataUrls: inheritedScreenshots,
    message: 'Publishing a new version without reselecting images',
  })

  const iconReplaced = await publishSmartAppVersion(client, {
    packagePath: packages.replaceIcon,
    smartAppId,
    version: '0.2.1',
    iconDataUrl: SMART_APP_ALT_ICON_DATA_URL,
    releaseNotes: 'Replace icon only',
  })
  assert.equal(iconReplaced.version, '0.2.1')
  await assertSmartAppAssetDigests(iconReplaced, {
    iconDataUrl: SMART_APP_ALT_ICON_DATA_URL,
    screenshotDataUrls: inheritedScreenshots,
    message: 'Replacing only the marketplace icon',
  })

  const screenshotsReplaced = await publishSmartAppVersion(client, {
    packagePath: packages.replaceScreenshots,
    smartAppId,
    version: '0.2.2',
    screenshotDataUrls: [SMART_APP_ALT_SCREENSHOT_DATA_URL],
    releaseNotes: 'Replace screenshots only',
  })
  assert.equal(screenshotsReplaced.version, '0.2.2')
  await assertSmartAppAssetDigests(screenshotsReplaced, {
    iconDataUrl: SMART_APP_ALT_ICON_DATA_URL,
    screenshotDataUrls: [SMART_APP_ALT_SCREENSHOT_DATA_URL],
    message: 'Replacing only the marketplace screenshots',
  })

  const missingIcon = await requestSmartAppJson(client, '/api/smart-apps/submissions/init', {
    method: 'POST',
    body: JSON.stringify({
      name: 'dsh-e2e-missing-icon',
      displayName: 'Missing icon E2E',
      version: '1.0.0',
      filename: 'dsh-e2e-missing-icon.zip',
      sha256: '0'.repeat(64),
      sizeBytes: 1,
      summary: 'Missing icon',
      descriptionMd: '',
      tags: ['data_analysis'],
      scope: 'public',
    }),
  })
  assert.equal(missingIcon.status, 422, 'A first publication without an icon was accepted')
  const owned = await ownerRequest('/api/smart-apps/owned')
  assert.ok(
    !owned.items.some(item => item.name === 'dsh-e2e-missing-icon'),
    'A rejected first publication created a marketplace app'
  )

  const cancelled = await initSmartAppVersion(client, {
    packagePath: packages.cancel,
    smartAppId,
    version: '0.2.3',
    iconDataUrl: SMART_APP_ICON_DATA_URL,
    screenshotDataUrls: [SMART_APP_SCREENSHOT_DATA_URL],
    releaseNotes: 'Cancelled publication',
  })
  await ownerRequest(`/api/smart-apps/submissions/${cancelled.submissionId}/cancel`, {
    method: 'POST',
  })
  await assertCurrentSmartAppAssetDigests(client.ownerRequest, smartAppId, {
    version: '0.2.2',
    iconDataUrl: SMART_APP_ALT_ICON_DATA_URL,
    screenshotDataUrls: [SMART_APP_ALT_SCREENSHOT_DATA_URL],
    message: 'Cancelling a publication',
  })

  const failed = await initSmartAppVersion(client, {
    packagePath: packages.fail,
    smartAppId,
    version: '0.2.4',
    iconDataUrl: SMART_APP_ICON_DATA_URL,
    screenshotDataUrls: [SMART_APP_SCREENSHOT_DATA_URL],
    releaseNotes: 'Failed publication',
  })
  const failedCompletion = await requestSmartAppJson(
    client,
    `/api/smart-apps/submissions/${failed.submissionId}/complete`,
    { method: 'POST' }
  )
  assert.notEqual(
    failedCompletion.status,
    200,
    'A publication without an uploaded package succeeded'
  )
  await assertCurrentSmartAppAssetDigests(client.ownerRequest, smartAppId, {
    version: '0.2.2',
    iconDataUrl: SMART_APP_ALT_ICON_DATA_URL,
    screenshotDataUrls: [SMART_APP_ALT_SCREENSHOT_DATA_URL],
    message: 'Failing a publication',
  })

  const cleared = await publishSmartAppVersion(client, {
    packagePath: packages.clearScreenshots,
    smartAppId,
    version: '0.2.5',
    screenshotDataUrls: [],
    releaseNotes: 'Clear screenshots explicitly',
  })
  assert.equal(cleared.version, '0.2.5')
  await assertSmartAppAssetDigests(cleared, {
    iconDataUrl: SMART_APP_ALT_ICON_DATA_URL,
    screenshotDataUrls: [],
    message: 'Clearing marketplace screenshots explicitly',
  })
}

async function initSmartAppVersion(
  client,
  { packagePath, smartAppId, version, iconDataUrl, screenshotDataUrls, releaseNotes }
) {
  const packageBytes = await readFile(packagePath)
  const initialized = await client.ownerRequest('/api/smart-apps/submissions/init', {
    method: 'POST',
    body: JSON.stringify({
      smartAppId,
      name: INSTALLATION_ID,
      displayName: 'DSH E2E Shared',
      version,
      filename: basename(packagePath),
      sha256: createHash('sha256').update(packageBytes).digest('hex'),
      sizeBytes: packageBytes.length,
      summary: 'Shared desktop E2E Smart app',
      descriptionMd: '# Shared desktop E2E Smart app',
      tags: ['data_analysis'],
      releaseNotes,
      ...(iconDataUrl ? { iconDataUrl } : {}),
      ...(screenshotDataUrls === undefined ? {} : { screenshotDataUrls }),
    }),
  })
  return { ...initialized, packageBytes }
}

async function publishSmartAppVersion(client, options) {
  const { submissionId, uploadUrl, packageBytes } = await initSmartAppVersion(client, options)
  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip' },
    body: packageBytes,
  })
  assert.equal(upload.ok, true, `Smart app package upload failed with HTTP ${upload.status}`)
  const completed = await client.ownerRequest(
    `/api/smart-apps/submissions/${submissionId}/complete`,
    { method: 'POST' }
  )
  assert.ok(completed.item, 'Smart app publication did not return the marketplace item')
  return completed.item
}

async function requestSmartAppJson(client, pathname, options = {}) {
  const response = await fetch(`${client.backendUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${client.authToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: response.status, body }
}

async function waitForSmartAppVersion(ownerRequest, smartAppId, version, timeoutMs) {
  const startedAt = Date.now()
  let current = null
  while (Date.now() - startedAt < timeoutMs) {
    current = await ownerRequest(`/api/smart-apps/marketplace/${smartAppId}`)
    if (current.version === version) return current
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(
    `Smart app did not reach version ${version}; latest was ${current?.version ?? 'unknown'}`
  )
}

async function assertCurrentSmartAppAssetDigests(
  ownerRequest,
  smartAppId,
  { version, ...expected }
) {
  const item = await ownerRequest(`/api/smart-apps/marketplace/${smartAppId}`)
  assert.equal(item.version, version)
  await assertSmartAppAssetDigests(item, expected)
}

async function assertSmartAppAssetDigests(item, { iconDataUrl, screenshotDataUrls, message }) {
  assert.ok(item.iconUrl, `${message}: marketplace icon URL is missing`)
  assert.equal(
    await downloadSmartAppAssetDigest(item.iconUrl),
    dataUrlDigest(iconDataUrl),
    `${message}: marketplace icon content changed`
  )
  assert.deepEqual(
    await Promise.all(item.screenshotUrls.map(downloadSmartAppAssetDigest)),
    screenshotDataUrls.map(dataUrlDigest),
    `${message}: marketplace screenshot content changed`
  )
}

async function downloadSmartAppAssetDigest(url) {
  const response = await fetch(url)
  assert.equal(response.ok, true, `Smart app asset download failed with HTTP ${response.status}`)
  return createHash('sha256')
    .update(Buffer.from(await response.arrayBuffer()))
    .digest('hex')
}

function dataUrlDigest(dataUrl) {
  const separator = dataUrl.indexOf(',')
  return createHash('sha256')
    .update(Buffer.from(dataUrl.slice(separator + 1), 'base64'))
    .digest('hex')
}
