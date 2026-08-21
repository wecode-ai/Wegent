import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'

const INSTALLATION_ID = 'dsh-e2e-smoke'
const APP_ROUTE = `/app/harness-${INSTALLATION_ID}`
const MODEL_LABEL = 'Desktop E2E Chat'
const RECIPIENT_NAME = 'smart-app-e2e-recipient'
const STRANGER_NAME = 'smart-app-e2e-stranger'
const USER_PASSWORD = 'smart-app-e2e-password'

async function requestJson(baseUrl, token, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${text}`
  )
  return body
}

async function setExperimentalFeatures(control, enabled, uiTimeoutMs) {
  await control.command('navigate', 'body', { value: '/settings/general' })
  await control.command('waitFor', '[data-testid="general-experimental-features-toggle"]', {
    timeoutMs: uiTimeoutMs,
  })
  const expected = String(enabled)
  if (
    (await control.command('getAttribute', '[data-testid="general-experimental-features-toggle"]', {
      value: 'aria-checked',
    })) !== expected
  ) {
    await control.command('click', '[data-testid="general-experimental-features-toggle"]')
  }
  await control.command(
    'waitFor',
    `[data-testid="general-experimental-features-toggle"][aria-checked="${expected}"]`,
    {
      stableMs: 300,
      timeoutMs: uiTimeoutMs,
    }
  )
}

async function waitForElementCount(control, selector, expected, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (Number(await control.command('getElementCount', selector)) === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

async function createHarnessPackage(resultDir) {
  const packagePath = join(resultDir, 'dsh-e2e-smoke.zip')
  const zip = new JSZip()
  const root = zip.folder('harness-e2e-plugin')
  root.file('PLUGIN.md', '# Harness desktop E2E\n')
  root.file('INSTALL.zh-CN.md', '# 安装\n')
  root.file(
    'plugin-manifest.json',
    JSON.stringify(
      {
        name: INSTALLATION_ID,
        displayName: 'DSH E2E Smoke',
        version: '0.1.0',
        type: 'deepseek-harness-plugin-bundle',
        description: 'Desktop E2E Harness smoke package',
        entry: {
          installPackage: 'packages/bundle/smoke-app',
          profile: 'smoke',
          webUrl: 'http://127.0.0.1:3080/',
        },
        requirements: {
          dsh: '0.1.0-rc.8',
          node: '>=22',
        },
        defaultModel: {
          provider: 'fixture',
          model: 'fixture',
          configPath: '$DSH_HOME/profiles/smoke/cordis.patch.yml',
        },
      },
      null,
      2
    )
  )
  const bundle = root.folder('packages/bundle/smoke-app')
  bundle.file(
    'package.json',
    JSON.stringify(
      {
        name: '@wework/dsh-e2e-smoke',
        version: '0.1.0',
        type: 'module',
        main: 'lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2
    )
  )
  bundle.file('lib/index.js', 'export default {}\n')
  bundle.file(
    'cordis.patch.yml',
    '- id: ui-model-selection\n  config:\n    provider: fixture\n    model: fixture\n'
  )
  await writeFile(
    packagePath,
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  )
  return packagePath
}

async function createOfficialSource(resultDir, packagePath) {
  const source = join(resultDir, 'official-smart-app')
  await rm(source, { recursive: true, force: true })
  await mkdir(source, { recursive: true })
  const archive = await JSZip.loadAsync(await readFile(packagePath))
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue
    const relative = entry.name.replace(/^harness-e2e-plugin\//, '')
    if (!relative || relative === entry.name) continue
    const target = join(source, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await entry.async('nodebuffer'))
  }
  await writeFile(
    join(source, 'icon.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
  )
  await writeFile(
    join(source, 'smart-app-marketplace.json'),
    JSON.stringify({
      summary: 'Official desktop E2E Smart app',
      descriptionMd: '# Official desktop E2E Smart app',
      tags: ['data_analysis'],
      icon: 'icon.png',
      releaseNotes: 'Initial official E2E release',
      extensions: {
        schemaVersion: 1,
        'com.weibo.internal': { businessOwner: 'desktop-e2e' },
      },
      releaseExtensions: {
        'com.weibo.build': { pipeline: 'desktop-e2e-official' },
      },
    })
  )
  return source
}

export async function createDesktopScenario({ captureScreenshot, resultDir, uiTimeoutMs }) {
  const packagePath = await createHarnessPackage(resultDir)
  const officialSource = await createOfficialSource(resultDir, packagePath)
  return {
    requiresCloudEnvironment: true,

    async prepareCloud({ authToken, backendUrl, publishOfficialSmartApp }) {
      await publishOfficialSmartApp(officialSource)
      const ownerRequest = (pathname, options) =>
        requestJson(backendUrl, authToken, pathname, options)
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
      const packageBytes = await readFile(packagePath)
      const initialized = await ownerRequest('/api/smart-apps/submissions/init', {
        method: 'POST',
        body: JSON.stringify({
          name: INSTALLATION_ID,
          displayName: 'DSH E2E Shared',
          version: '0.1.0',
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
          targets: [
            {
              entityType: 'user',
              entityId: String(recipient.id),
              displayName: recipient.user_name,
            },
          ],
        }),
      })
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
      await setExperimentalFeatures(control, false, uiTimeoutMs)
      await control.command('navigate', 'body', { value: '/' })
      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="workspace-tab-add-smart-app"]')
        ),
        0,
        'Smart apps were visible before experimental features were enabled'
      )
      await captureScreenshot(control, 'harness-apps-00-experimental-hidden.png', 'body')
      await control.command('click', '[data-testid="workspace-tab-add"]')

      await setExperimentalFeatures(control, true, uiTimeoutMs)
      await captureScreenshot(control, 'harness-apps-01-experimental-enabled.png', 'body')

      await control.command('navigate', 'body', { value: '/' })
      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command('waitFor', '[data-testid="workspace-tab-add-smart-app"]', {
        text: '智能工作台',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-02-top-tab-entry.png', 'body')
      await control.command('click', '[data-testid="workspace-tab-add-smart-app"]')
      await control.command(
        'waitFor',
        '[data-testid="applications-tab-smart-app"][aria-selected="true"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid="smart-apps-marketplace-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="sidebar-worklists-scroll"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="smart-apps-section-nav"]', {
        text: '市场',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-03-marketplace.png', 'body')
      const marketplaceSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        marketplaceSnapshot.location.includes('/sites?app_type=smart_app'),
        `Smart app marketplace did not open from the top tab add menu: ${marketplaceSnapshot.location}`
      )
      const marketplaceText = await control.command(
        'getText',
        '[data-testid="smart-apps-marketplace-page"]'
      )
      assert.ok(
        !marketplaceText.includes('创建智能应用') && !marketplaceText.includes('导入应用'),
        'Smart app marketplace unexpectedly exposed creation actions'
      )
      await control.command('waitFor', '[data-testid="smart-app-marketplace-item-1"]', {
        text: 'DSH E2E Smoke',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="smart-app-marketplace-install-1"]')
      await control.command('waitFor', '[data-testid="harness-app-preview"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', '[data-testid="harness-app-install-confirm"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="harness-app-start-market-1"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="harness-app-start-market-1"]')
      await control.command('waitFor', '[data-testid="harness-app-launch-market-1"]', {
        timeoutMs: 60_000,
      })
      await control.command('waitFor', '[data-testid="app-iframe-harness-market-1"]', {
        timeoutMs: 600_000,
      })
      await captureScreenshot(control, 'harness-apps-03a-official-running.png', 'body')
      await control.command('navigate', 'body', {
        value: '/sites?app_type=smart_app&view=installed',
      })
      await control.command('waitFor', '[data-testid="harness-app-stop-market-1"]', {
        timeoutMs: 60_000,
      })
      await control.command('click', '[data-testid="harness-app-stop-market-1"]')
      await control.command('waitFor', '[data-testid="harness-app-start-market-1"]', {
        timeoutMs: 30_000,
      })
      await control.command('click', '[data-testid="smart-apps-section-marketplace"]')
      await control.command('waitFor', '[data-testid="smart-apps-marketplace-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="smart-apps-section-owned"]')
      await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
        text: '我的创建',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="smart-apps-created-create"]')
      await control.command('waitFor', '[data-testid="chat-message-input"]', {
        text: '智能工作台开发助手',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-03a-builder-chat.png', 'body')
      await control.command('navigate', 'body', {
        value: '/sites?app_type=smart_app&view=owned',
      })
      await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('dropPaths', '[data-testid="smart-apps-owned-page"]', {
        value: JSON.stringify([
          {
            uri: pathToFileURL(packagePath).href,
            name: 'dsh-e2e-smoke.zip',
            mimeType: 'application/zip',
          },
        ]),
      })
      await control.command(
        'waitFor',
        `[data-testid="smart-app-created-item-${INSTALLATION_ID}"]`,
        {
          text: 'DSH E2E Smoke',
          timeoutMs: uiTimeoutMs,
        }
      )
      await captureScreenshot(control, 'harness-apps-04-created.png', 'body')
      await control.command(
        'clickWhenEnabled',
        `[data-testid="smart-app-created-publish-${INSTALLATION_ID}"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid="smart-app-publish-dialog"]', {
        text: '选择文件',
        timeoutMs: uiTimeoutMs,
      })
      const publishDialogText = await control.command(
        'getText',
        '[data-testid="smart-app-publish-dialog"]'
      )
      assert.ok(
        publishDialogText.includes('未选择文件'),
        'Smart app publish dialog did not show the localized empty file state'
      )
      assert.ok(
        !publishDialogText.includes('Choose File') &&
          !publishDialogText.includes('no file selected'),
        'Smart app publish dialog leaked native English file picker text'
      )
      await captureScreenshot(control, 'harness-apps-04a-publish-dialog-zh.png', 'body')
      await control.command('click', '[data-testid="smart-app-publish-close"]')
      await control.command('navigate', 'body', {
        value: '/sites?app_type=smart_app&view=installed',
      })
      await control.command('waitFor', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="smart-apps-section-installed"]', {
        text: '已安装',
        timeoutMs: uiTimeoutMs,
      })
      const harnessManagementSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        harnessManagementSnapshot.location.includes('app_type=smart_app') &&
          harnessManagementSnapshot.location.includes('view=installed'),
        `Installed Smart apps did not open: ${harnessManagementSnapshot.location}`
      )
      const managementTabId = await control.command(
        'getAttribute',
        '[data-workspace-tab-content][aria-hidden="false"]',
        { value: 'data-workspace-tab-content' }
      )
      assert.ok(managementTabId, 'Harness management page did not expose its workspace tab ID')
      await captureScreenshot(control, 'harness-apps-05-installed.png', 'body')

      const modelSelector = `[data-testid="harness-app-model-${INSTALLATION_ID}"]`
      const initialModelKey = await control.command('getValue', modelSelector)
      await control.command('select', modelSelector, {
        by: 'label',
        value: MODEL_LABEL,
      })
      await control.command('waitFor', modelSelector, {
        enabled: true,
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })
      const selectedModelKey = await control.command('getValue', modelSelector)
      assert.notEqual(
        selectedModelKey,
        initialModelKey,
        'Changing the installed Smart app model did not persist a new selection'
      )
      const residentButton = `[data-testid="harness-app-resident-${INSTALLATION_ID}"]`
      await control.command('click', residentButton)
      await control.command('waitFor', `${residentButton}[aria-pressed="true"]`, {
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-06-model-and-resident.png', 'body')

      await control.command('click', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`)
      await control.command('waitFor', `[data-testid="harness-app-launch-${INSTALLATION_ID}"]`, {
        timeoutMs: 30_000,
      })
      await captureScreenshot(control, 'harness-apps-07-tab-starting.png', 'body')
      const appSurface = `[data-testid="app-iframe-harness-${INSTALLATION_ID}"]`
      await control.command('waitFor', appSurface, {
        timeoutMs: 600_000,
      })
      const appTabId = await control.command('getAttribute', appSurface, {
        value: 'data-workspace-tab-id',
      })
      const appWebviewLabel = await control.command('getAttribute', appSurface, {
        value: 'data-embedded-browser-label',
      })
      assert.ok(appTabId, 'Harness app did not expose its workspace tab ID')
      assert.ok(appWebviewLabel, 'Harness app did not expose its native WebView label')
      const nativeSnapshot = await control.command('captureEmbeddedBrowser', appSurface, {
        text: APP_ROUTE,
        timeoutMs: 30_000,
      })
      assert.ok(
        nativeSnapshot.startsWith('data:image/png;base64,'),
        'Harness native WebView did not produce a screenshot'
      )
      await writeFile(
        join(resultDir, 'harness-apps-08-native-page.png'),
        Buffer.from(nativeSnapshot.slice('data:image/png;base64,'.length), 'base64')
      )
      const harnessStateKey = '__weworkHarnessTabState'
      const harnessStateValue = `preserved-${Date.now()}`
      await control.command('setEmbeddedBrowserWindowValue', 'body', {
        value: JSON.stringify({
          key: harnessStateKey,
          label: appWebviewLabel,
          value: harnessStateValue,
        }),
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
      await control.command(
        'waitFor',
        `[data-testid="workspace-tab-content-${managementTabId}"][aria-hidden="false"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('click', `[data-testid="workspace-tab-select-${appTabId}"]`)
      await control.command(
        'waitFor',
        `[data-testid="workspace-tab-content-${appTabId}"][aria-hidden="false"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      assert.equal(
        await control.command('getEmbeddedBrowserWindowValue', 'body', {
          value: JSON.stringify({
            key: harnessStateKey,
            label: appWebviewLabel,
          }),
          timeoutMs: uiTimeoutMs,
        }),
        harnessStateValue,
        'Switching away from and back to a Harness app reset its in-memory page state'
      )
      const taskTabSelector = '[role="tab"][data-tab-kind="task"]'
      await control.command('click', taskTabSelector)
      await control.command(
        'waitFor',
        '[data-testid="workbench-main-header"] [data-testid="titlebar-main-actions"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        '[data-testid="workbench-main-header"] [data-testid="toggle-right-workspace-panel-button"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('click', `[data-testid="workspace-tab-select-${appTabId}"]`)
      await control.command(
        'waitFor',
        `[data-testid="workspace-tab-content-${appTabId}"][aria-hidden="false"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
      await control.command(
        'waitFor',
        `[data-testid="workspace-tab-content-${managementTabId}"][aria-hidden="false"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', `[data-testid="harness-app-stop-${INSTALLATION_ID}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-09-running.png', 'body')
      await control.command('click', `[data-testid="workspace-tab-close-${appTabId}"]`)
      await waitForElementCount(
        control,
        `[data-testid="app-iframe-harness-${INSTALLATION_ID}"]`,
        0,
        uiTimeoutMs,
        'Closing a running Harness app tab left its app surface mounted'
      )
      await control.command('click', `[data-testid="harness-app-open-${INSTALLATION_ID}"]`)
      await control.command('waitFor', appSurface, {
        timeoutMs: 30_000,
      })
      await captureScreenshot(control, 'harness-apps-09a-reopened.png', 'body')
      const reopenedAppTabId = await control.command('getAttribute', appSurface, {
        value: 'data-workspace-tab-id',
      })
      assert.ok(reopenedAppTabId, 'Reopened Harness app did not expose its workspace tab ID')
      await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
      await control.command(
        'waitFor',
        `[data-testid="workspace-tab-content-${managementTabId}"][aria-hidden="false"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('click', `[data-testid="harness-app-stop-${INSTALLATION_ID}"]`)
      await control.command('waitFor', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`, {
        timeoutMs: 30_000,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `[data-testid="app-iframe-harness-${INSTALLATION_ID}"]`
          )
        ),
        0,
        'Stopping a Harness app left its stale app tab mounted'
      )
      const readyCountBeforeReload = control.readyCount
      const stoppedSnapshot = await control.command('reloadMainWindow', 'body', {
        value: 'capture',
        timeoutMs: 90_000,
      })
      assert.ok(
        stoppedSnapshot.startsWith('data:image/png;base64,'),
        'Stopped Smart app state did not produce a screenshot before reload'
      )
      await writeFile(
        join(resultDir, 'harness-apps-10-stopped.png'),
        Buffer.from(stoppedSnapshot.slice('data:image/png;base64,'.length), 'base64')
      )
      await control.awaitReadyAfter(readyCountBeforeReload)
      const residentNativeSnapshot = await control.command(
        'captureEmbeddedBrowser',
        `[data-testid="app-iframe-harness-${INSTALLATION_ID}"]`,
        {
          target: `[data-testid="workspace-tab-select-${managementTabId}"]`,
          text: APP_ROUTE,
          timeoutMs: 30_000,
        }
      )
      assert.ok(
        residentNativeSnapshot.startsWith('data:image/png;base64,'),
        'Resident Smart app native WebView did not produce a screenshot'
      )
      await writeFile(
        join(resultDir, 'harness-apps-11-resident-auto-opened.png'),
        Buffer.from(residentNativeSnapshot.slice('data:image/png;base64,'.length), 'base64')
      )

      await control.command('waitFor', `[data-testid="harness-app-stop-${INSTALLATION_ID}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getValue', modelSelector),
        selectedModelKey,
        'The selected Smart app model was not restored after reload'
      )
      await control.command('waitFor', `${residentButton}[aria-pressed="true"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-13-settings-restored.png', 'body')
      await control.command('click', residentButton)
      await control.command('waitFor', `${residentButton}[aria-pressed="false"]`, {
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `[data-testid="harness-app-stop-${INSTALLATION_ID}"]`)
      await control.command('waitFor', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`, {
        timeoutMs: 30_000,
      })
      await captureScreenshot(control, 'harness-apps-14-resident-disabled.png', 'body')

      await control.command('click', '[data-testid="smart-apps-section-marketplace"]')
      await control.command(
        'waitFor',
        '[data-testid="smart-apps-section-marketplace"][aria-current="page"]',
        {
          stableMs: 1000,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid="smart-apps-marketplace-page"]', {
        stableMs: 1000,
        timeoutMs: uiTimeoutMs,
      })
      const returnedMarketplaceSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        returnedMarketplaceSnapshot.location.includes('/sites?app_type=smart_app') &&
          !returnedMarketplaceSnapshot.location.includes('view=installed'),
        `Installed Smart apps did not return to the marketplace: ${returnedMarketplaceSnapshot.location}`
      )
      await captureScreenshot(control, 'harness-apps-15-returned-to-marketplace.png', 'body')

      await setExperimentalFeatures(control, false, uiTimeoutMs)
      await control.command('navigate', 'body', { value: '/sites' })
      await control.command('waitFor', '[data-testid="sites-workspace"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="applications-tab-smart-app"]')
        ),
        0,
        'Smart apps remained visible in Applications after experimental features were disabled'
      )
      await control.command('navigate', 'body', { value: '/' })
      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add"]')
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="workspace-tab-add-smart-app"]')
        ),
        0,
        'Smart apps remained visible after experimental features were disabled'
      )
      await captureScreenshot(control, 'harness-apps-16-experimental-disabled.png', 'body')
    },
  }
}
