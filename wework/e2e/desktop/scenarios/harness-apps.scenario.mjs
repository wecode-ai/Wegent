import {
  createHarnessPackage,
  INSTALLATION_ID,
  createLocalDshPlugin,
  IMPORTED_INSTALLATION_ID,
  LEGACY_INSTALLATION_ID,
  createOfficialSource,
  requestJson,
  RECIPIENT_NAME,
  SMART_APP_ICON_DATA_URL,
  STRANGER_NAME,
  USER_PASSWORD,
} from '../modules/harness-app-fixture.mjs'
import { join } from 'node:path'
import { verifyDefaultOnlyDshPackage } from '../modules/dsh-runtime-cache.mjs'
import { fetchGithubReleaseAsset } from '../modules/github-release-asset.mjs'
import { packagedResourcesRoot } from '../modules/workbench-schema-compatibility.mjs'
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { prepareHarnessAppUi } from '../modules/harness-app-bootstrap.mjs'
import { verifyHarnessDevelopment } from '../modules/harness-app-development.mjs'
import { verifyHarnessLifecycle } from '../modules/harness-app-lifecycle.mjs'
import { verifyHarnessAppModels } from '../modules/harness-app-models.mjs'
import {
  createSmartAppArchiveRegression,
  verifySmartAppArchiveRegression,
} from '../modules/smart-app-archive-regression.mjs'

export async function createDesktopScenario({
  checkpoint,
  captureScreenshot,
  electronUserDataDirectory,
  resultDir,
  releaseAssetToken,
  uiTimeoutMs,
}) {
  const packagePath = await createHarnessPackage(resultDir, INSTALLATION_ID, '0.2.0-rc.2')
  const legacyPackagePath = await createHarnessPackage(
    resultDir,
    LEGACY_INSTALLATION_ID,
    '0.1.0-rc.8'
  )
  const localDshPluginPath = await createLocalDshPlugin(resultDir)
  const importedPackagePath = await createHarnessPackage(
    resultDir,
    IMPORTED_INSTALLATION_ID,
    '0.2.0-rc.2'
  )
  const sharedPackagePath = await createHarnessPackage(resultDir, INSTALLATION_ID, '0.2.0-rc.2', {
    archiveName: 'dsh-e2e-shared-0.0.9',
    version: '0.0.9',
  })
  const smartAppLifecyclePackages =
    checkpoint === 'harness-app-lifecycle'
      ? {
          seedAssets: await createHarnessPackage(resultDir, INSTALLATION_ID, '0.2.0-rc.2', {
            archiveName: 'dsh-e2e-smoke-0.0.10',
            version: '0.0.10',
          }),
          replaceIcon: await createHarnessPackage(resultDir, INSTALLATION_ID, '0.2.0-rc.2', {
            archiveName: 'dsh-e2e-smoke-0.2.1',
            version: '0.2.1',
          }),
          replaceScreenshots: await createHarnessPackage(resultDir, INSTALLATION_ID, '0.2.0-rc.2', {
            archiveName: 'dsh-e2e-smoke-0.2.2',
            version: '0.2.2',
          }),
          cancel: await createHarnessPackage(resultDir, INSTALLATION_ID, '0.2.0-rc.2', {
            archiveName: 'dsh-e2e-smoke-0.2.3',
            version: '0.2.3',
          }),
          fail: await createHarnessPackage(resultDir, INSTALLATION_ID, '0.2.0-rc.2', {
            archiveName: 'dsh-e2e-smoke-0.2.4',
            version: '0.2.4',
          }),
          clearScreenshots: await createHarnessPackage(resultDir, INSTALLATION_ID, '0.2.0-rc.2', {
            archiveName: 'dsh-e2e-smoke-0.2.5',
            version: '0.2.5',
          }),
        }
      : null
  const officialSource = await createOfficialSource(resultDir, packagePath)
  const archiveRegression =
    checkpoint === 'harness-app-lifecycle' ? await createSmartAppArchiveRegression(resultDir) : null
  let publishUpdatedRelease
  const downloadsPath = join(resultDir, 'downloads')
  await mkdir(downloadsPath, { recursive: true })
  let sharedSmartAppId = null
  let ownerRequest
  let smartAppBackendUrl = ''
  let smartAppAuthToken = ''
  return {
    requiresCloudEnvironment: true,
    // Reproduce a workbench launched from a DSH-backed terminal. Legacy apps must
    // ignore the parent's authentication state while Core DSH keeps its own auth.
    appEnvironment: {
      WEWORK_E2E_DOWNLOADS_DIR: downloadsPath,
      WEWORK_DSH_BROWSER_AUTH: '1',
      WEWORK_DSH_BROWSER_AUTH_FD: '99',
    },
    async prepareApp({ appBinary, appEnvironment }) {
      const legacy = await verifyDefaultOnlyDshPackage(
        join(packagedResourcesRoot(appBinary), 'harness-runtime'),
        join(resultDir, 'harness-runtime')
      )
      if (releaseAssetToken) {
        const response = await fetchGithubReleaseAsset({
          repository: 'wecode-ai/Wegent',
          tag: 'wework-updater',
          name: legacy.assetName,
          redirect: 'manual',
          token: releaseAssetToken,
        })
        assert.equal(response.status, 302, 'Expected an official GitHub release CDN redirect')
        appEnvironment.WEWORK_E2E_DSH_RELEASE_REDIRECT = JSON.stringify({
          source: legacy.downloadUrl,
          target: response.headers.get('location'),
        })
      }
    },

    async prepareCloud({ authToken, backendUrl, publishOfficialSmartApp }) {
      smartAppBackendUrl = backendUrl
      smartAppAuthToken = authToken
      await publishOfficialSmartApp(officialSource)
      if (archiveRegression) {
        await publishOfficialSmartApp(archiveRegression.sources[0])
        publishUpdatedRelease = publishOfficialSmartApp
      }
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
          iconDataUrl: SMART_APP_ICON_DATA_URL,
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
      if (checkpoint === 'harness-app-models') {
        await verifyHarnessAppModels(control, {
          uiTimeoutMs,
          resultDir,
          captureScreenshot,
          electronUserDataDirectory,
        })
        return
      }
      const { legacyRuntimeCache } = await prepareHarnessAppUi(control, {
        legacyPackagePath,
        uiTimeoutMs,
        captureScreenshot,
        electronUserDataDirectory,
        resultDir,
      })
      if (checkpoint === 'harness-app-development') {
        try {
          await verifyHarnessDevelopment(control, {
            uiTimeoutMs,
            resultDir,
            captureScreenshot,
            electronUserDataDirectory,
            legacyRuntimeCache,
            localDshPluginPath,
            downloadsPath,
          })
        } finally {
          const logs = join(resultDir, 'dsh-e2e-created', 'test-results', 'smart-app', 'logs')
          let entries = []
          try {
            entries = await readdir(logs, { withFileTypes: true })
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.log')) {
              await copyFile(
                join(logs, entry.name),
                join(resultDir, `smart-app-verification-${entry.name}`)
              )
            }
          }
        }
      } else if (checkpoint === 'harness-app-lifecycle') {
        assert.ok(
          archiveRegression && publishUpdatedRelease,
          'Archive regression fixtures were not prepared'
        )
        await verifySmartAppArchiveRegression(control, {
          fixture: archiveRegression,
          ownerRequest,
          publishUpdatedRelease,
          electronUserDataDirectory,
          uiTimeoutMs,
        })
        await verifyHarnessLifecycle(control, {
          packagePath,
          uiTimeoutMs,
          captureScreenshot,
          importedPackagePath,
          sharedSmartAppId,
          ownerRequest,
          backendUrl: smartAppBackendUrl,
          authToken: smartAppAuthToken,
          smartAppLifecyclePackages,
          downloadsPath,
          resultDir,
          legacyRuntimeCache,
        })
      }
    },
  }
}
