import {
  createHarnessPackage,
  INSTALLATION_ID,
  createLocalDshPlugin,
  IMPORTED_INSTALLATION_ID,
  createOfficialSource,
  requestJson,
  RECIPIENT_NAME,
  STRANGER_NAME,
  USER_PASSWORD,
} from '../modules/harness-app-fixture.mjs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { verifyDefaultOnlyDshPackage } from '../modules/dsh-runtime-cache.mjs'
import { packagedResourcesRoot } from '../modules/workbench-schema-compatibility.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { prepareHarnessAppUi } from '../modules/harness-app-bootstrap.mjs'
import { verifyHarnessDevelopment } from '../modules/harness-app-development.mjs'
import { verifyHarnessLifecycle } from '../modules/harness-app-lifecycle.mjs'

export async function createDesktopScenario({
  checkpoint,
  captureScreenshot,
  electronUserDataDirectory,
  resultDir,
  uiTimeoutMs,
}) {
  const packagePath = await createHarnessPackage(resultDir, INSTALLATION_ID, '0.1.0-rc.8')
  const localDshPluginPath = await createLocalDshPlugin(resultDir)
  const importedPackagePath = await createHarnessPackage(
    resultDir,
    IMPORTED_INSTALLATION_ID,
    '0.1.0-rc.8'
  )
  const sharedPackagePath = await createHarnessPackage(resultDir, INSTALLATION_ID, '0.1.0-rc.8', {
    archiveName: 'dsh-e2e-shared-0.0.9',
    version: '0.0.9',
  })
  const officialSource = await createOfficialSource(resultDir, packagePath)
  // Electron falls back to HOME on Linux when XDG user directories are unavailable.
  const downloadsPath =
    process.platform === 'linux' ? join(resultDir, 'home') : join(homedir(), 'Downloads')
  let sharedSmartAppId = null
  let ownerRequest
  return {
    requiresCloudEnvironment: true,
    async prepareApp({ appBinary }) {
      await verifyDefaultOnlyDshPackage(
        join(packagedResourcesRoot(appBinary), 'harness-runtime'),
        join(resultDir, 'harness-runtime')
      )
    },

    async prepareCloud({ authToken, backendUrl, publishOfficialSmartApp }) {
      await publishOfficialSmartApp(officialSource)
      ownerRequest = (pathname, options) => requestJson(backendUrl, authToken, pathname, options)
      const ownerCatalog = await ownerRequest('/api/smart-apps/marketplace')
      const officialItem = ownerCatalog.items.find(
        item => item.name === INSTALLATION_ID && item.sourceType === 'official'
      )
      assert.deepEqual(officialItem?.extensions?.['com.weibo.internal'], {
        businessOwner: 'desktop-e2e',
      })
      assert.deepEqual(officialItem?.releaseExtensions?.['com.weibo.build'], {
        pipeline: 'desktop-e2e-official',
      })
      const officialDownload = await ownerRequest(
        `/api/smart-apps/marketplace/${officialItem.id}/download`,
        { method: 'POST' }
      )
      assert.match(
        officialDownload.downloadUrl,
        new RegExp(`^/api/smart-apps/marketplace/${officialItem.id}/artifact\\?token=`),
        'Smart app download descriptor did not use the Backend artifact proxy'
      )
      const [recipient, stranger] = await Promise.all(
        [RECIPIENT_NAME, STRANGER_NAME].map(user_name =>
          ownerRequest('/api/admin/users', {
            method: 'POST',
            body: JSON.stringify({
              user_name,
              password: USER_PASSWORD,
              role: 'user',
              auth_source: 'password',
            }),
          })
        )
      )
      const [recipientLogin, strangerLogin] = await Promise.all(
        [RECIPIENT_NAME, STRANGER_NAME].map(user_name =>
          requestJson(backendUrl, null, '/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ user_name, password: USER_PASSWORD }),
          })
        )
      )
      const packageBytes = await readFile(sharedPackagePath)
      const initialized = await ownerRequest('/api/smart-apps/submissions/init', {
        method: 'POST',
        body: JSON.stringify({
          name: INSTALLATION_ID,
          displayName: 'DSH E2E Shared',
          version: '0.0.9',
          filename: 'dsh-e2e-shared.zip',
          sha256: createHash('sha256').update(packageBytes).digest('hex'),
          sizeBytes: packageBytes.length,
          summary: 'Shared desktop E2E Smart app',
          descriptionMd: '# Shared desktop E2E Smart app',
          tags: ['data_analysis'],
          iconDataUrl:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          screenshotDataUrls: [],
          releaseNotes: 'Initial shared E2E release',
          extensions: {
            'io.wegent.e2e': { owner: 'shared-app' },
          },
          releaseExtensions: {
            'io.wegent.build': { pipeline: 'desktop-e2e-user' },
          },
          scope: 'restricted',
          targets: [
            {
              entityType: 'user',
              entityId: String(recipient.id),
              displayName: recipient.user_name,
            },
          ],
        }),
      })
      sharedSmartAppId = initialized.smartAppId
      const upload = await fetch(initialized.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/zip' },
        body: packageBytes,
      })
      assert.equal(upload.ok, true, `Smart app E2E upload failed with HTTP ${upload.status}`)
      const completed = await ownerRequest(
        `/api/smart-apps/submissions/${initialized.submissionId}/complete`,
        { method: 'POST' }
      )
      assert.equal(completed.item.extensions.schemaVersion, 1)
      assert.deepEqual(completed.item.extensions['io.wegent.e2e'], { owner: 'shared-app' })
      assert.deepEqual(completed.item.releaseExtensions['io.wegent.build'], {
        pipeline: 'desktop-e2e-user',
      })
      const recipientCatalog = await requestJson(
        backendUrl,
        recipientLogin.access_token,
        '/api/smart-apps/marketplace'
      )
      const strangerCatalog = await requestJson(
        backendUrl,
        strangerLogin.access_token,
        '/api/smart-apps/marketplace'
      )
      assert.ok(
        recipientCatalog.items.some(
          item => item.name === INSTALLATION_ID && item.sourceType === 'user'
        ),
        'Direct recipient could not discover the shared Smart app'
      )
      assert.ok(
        !strangerCatalog.items.some(
          item => item.name === INSTALLATION_ID && item.sourceType === 'user'
        ),
        `Unrelated user ${stranger.user_name} discovered the shared Smart app`
      )
      const publicAccess = await ownerRequest(`/api/smart-apps/${initialized.smartAppId}/access`, {
        method: 'PUT',
        body: JSON.stringify({ scope: 'public', targets: [] }),
      })
      assert.equal(publicAccess.isListed, true)
      assert.equal(publicAccess.latestReleaseId, completed.item.latestReleaseId)
      assert.equal(publicAccess.version, completed.item.version)
      const publicCatalog = await requestJson(
        backendUrl,
        strangerLogin.access_token,
        '/api/smart-apps/marketplace?source=public'
      )
      const publicItem = publicCatalog.items.find(
        item => item.name === INSTALLATION_ID && item.sourceType === 'user'
      )
      assert.equal(publicItem?.accessRole, 'public')
      assert.equal(publicItem?.visibility, 'public')
      const ownerPublicCatalog = await ownerRequest('/api/smart-apps/marketplace?source=public')
      const ownerPublicItem = ownerPublicCatalog.items.find(
        item => item.id === initialized.smartAppId
      )
      assert.equal(ownerPublicItem?.accessRole, 'owner')
      assert.equal(ownerPublicItem?.latestReleaseId, completed.item.latestReleaseId)
      await ownerRequest(`/api/smart-apps/${initialized.smartAppId}/access`, {
        method: 'PUT',
        body: JSON.stringify({ scope: 'private', targets: [] }),
      })
      const revokedCatalog = await requestJson(
        backendUrl,
        recipientLogin.access_token,
        '/api/smart-apps/marketplace'
      )
      assert.ok(
        !revokedCatalog.items.some(
          item => item.name === INSTALLATION_ID && item.sourceType === 'user'
        ),
        'Revoked recipient retained Smart app marketplace access'
      )
    },

    async verify(control) {
      const { legacyRuntimeCache } = await prepareHarnessAppUi(control, {
        uiTimeoutMs,
        captureScreenshot,
        electronUserDataDirectory,
        resultDir,
      })
      if (checkpoint === 'harness-app-development') {
        await verifyHarnessDevelopment(control, {
          uiTimeoutMs,
          resultDir,
          captureScreenshot,
          electronUserDataDirectory,
          legacyRuntimeCache,
          localDshPluginPath,
          downloadsPath,
        })
      } else {
        assert.equal(checkpoint, 'harness-app-lifecycle')
        await verifyHarnessLifecycle(control, {
          packagePath,
          uiTimeoutMs,
          captureScreenshot,
          importedPackagePath,
          sharedSmartAppId,
          ownerRequest,
          downloadsPath,
          resultDir,
          legacyRuntimeCache,
        })
      }
    },
  }
}
