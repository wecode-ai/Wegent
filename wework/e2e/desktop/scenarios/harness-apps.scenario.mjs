import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createZipFixture, extractSingleRootZipFixture } from '../modules/zip-fixtures.mjs'

const INSTALLATION_ID = 'dsh-e2e-smoke'
const IMPORTED_INSTALLATION_ID = 'dsh-e2e-smoke-imported'
const CREATED_INSTALLATION_ID = 'dsh-e2e-created'
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
    enabled: true,
    stableMs: 300,
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

async function waitForEmbeddedBrowserVisibility(
  control,
  label,
  expectedVisible,
  timeoutMs,
  message
) {
  const startedAt = Date.now()
  let lastState = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastState = JSON.parse(
        await control.command('getEmbeddedBrowserPageState', 'body', {
          value: label,
        })
      )
      const ready = expectedVisible ? lastState.url && lastState.isLoading === false : true
      if (lastState.visible === expectedVisible && ready) {
        return lastState
      }
    } catch {
      // Reloading temporarily removes the native browser before opening its replacement.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${message}: ${JSON.stringify(lastState)}`)
}

async function waitForManifestPlugin(manifestPath, pluginSpec, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.plugins?.some(plugin => plugin.spec === pluginSpec)) return manifest
    } catch {
      // The manifest can be temporarily unavailable while the package is being updated.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Smart app manifest did not include ${pluginSpec}`)
}

async function createHarnessPackage(
  resultDir,
  installationId,
  dshVersion,
  { archiveName = installationId, version = '0.1.0' } = {}
) {
  const packagePath = join(resultDir, `${archiveName}.zip`)
  const root = `harness-e2e-plugin-${installationId}`
  await createZipFixture(packagePath, {
    [`${root}/PLUGIN.md`]: '# Harness desktop E2E\n',
    [`${root}/INSTALL.zh-CN.md`]: '# 安装\n',
    [`${root}/plugin-manifest.json`]: JSON.stringify(
      {
        name: installationId,
        displayName: `DSH E2E Smoke ${dshVersion}`,
        version,
        type: 'deepseek-harness-plugin-bundle',
        description: 'Desktop E2E Harness smoke package',
        entry: {
          installPackage: 'packages/bundle/smoke-app',
          profile: 'smoke',
          webUrl: 'http://127.0.0.1:3080/',
        },
        requirements: {
          dsh: dshVersion,
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
    ),
    [`${root}/packages/bundle/smoke-app/package.json`]: JSON.stringify(
      {
        name: '@wework/dsh-e2e-smoke',
        version: '0.1.0',
        type: 'module',
        main: 'lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2
    ),
    [`${root}/packages/bundle/smoke-app/lib/index.js`]: 'export default {}\n',
    [`${root}/packages/bundle/smoke-app/cordis.patch.yml`]:
      '- id: ui-model-selection\n  config:\n    provider: fixture\n    model: fixture\n',
  })
  return packagePath
}

async function createOfficialSource(resultDir, packagePath) {
  const source = join(resultDir, 'official-smart-app')
  await extractSingleRootZipFixture(packagePath, source)
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
      descriptionMd:
        '# DSH E2E Smoke 0.1.0-rc.8\n\n面向现场演示的智能资料处理应用。上传文件后，可以选择工作表与文本列并完成分类。\n\n## 主要能力\n\n- 自动检查文件结构和数据预览\n- 支持自定义分类标签和兜底分类\n- 实时展示处理进度与失败行\n- 保留原始文件并下载处理结果\n\n## 演示建议\n\n准备一个包含文本列的小型文件，使用正向、负向和中性作为标签，快速展示完整流程。',
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

async function createLocalDshPlugin(resultDir) {
  const pluginPath = join(resultDir, 'local-dsh-plugin')
  await mkdir(pluginPath, { recursive: true })
  await writeFile(
    join(pluginPath, 'package.json'),
    JSON.stringify(
      {
        name: '@wework-e2e/local-dsh-plugin',
        version: '0.1.0',
        type: 'module',
        files: ['cordis.patch.yml'],
        dependencies: {
          'node-pty': '1.1.0',
        },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2
    )
  )
  await writeFile(join(pluginPath, 'cordis.patch.yml'), '[]\n')
  return pluginPath
}

export async function createDesktopScenario({ captureScreenshot, resultDir, uiTimeoutMs }) {
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
  let sharedSmartAppId = null
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
      await control.command('click', '[data-testid="smart-app-marketplace-item-1"] > button')
      await control.command('waitFor', '[data-testid="smart-app-details"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="smart-app-details-content"]', {
        text: '主要能力',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="smart-app-details-footer"]', {
        text: '下载并安装',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-03-details.png', 'body')
      await control.command('press', 'body', { key: 'Escape' })
      await waitForElementCount(
        control,
        '[data-testid="smart-app-details"]',
        0,
        uiTimeoutMs,
        'Smart app details dialog did not close after Escape'
      )
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
      const officialManagementTabId = await control.command(
        'getAttribute',
        '[data-workspace-tab-content][aria-hidden="false"]',
        { value: 'data-workspace-tab-content' }
      )
      assert.ok(
        officialManagementTabId,
        'Official Harness management page did not expose its workspace tab ID'
      )
      await control.command('click', '[data-testid="harness-app-start-market-1"]')
      await control.command('waitFor', '[data-testid="harness-app-launch-market-1"]', {
        timeoutMs: 60_000,
      })
      await control.command('waitFor', '[data-testid="app-iframe-harness-market-1"]', {
        timeoutMs: 600_000,
      })
      await control.command(
        'click',
        `[data-testid="workspace-tab-select-${officialManagementTabId}"]`
      )
      await control.command(
        'waitFor',
        `[data-testid="workspace-tab-select-${officialManagementTabId}"][aria-selected="true"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await captureScreenshot(control, 'harness-apps-03a-official-running.png', 'body')
      await control.command('waitFor', '[data-testid="smart-app-marketplace-actions-1"]', {
        timeoutMs: 60_000,
      })
      await control.command('click', '[data-testid="smart-app-marketplace-actions-1"]')
      await control.command('waitFor', `[data-testid="smart-app-stop-menu-market-1"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `[data-testid="smart-app-stop-menu-market-1"]`)
      await control.command('waitFor', '[data-testid="harness-app-start-market-1"]', {
        timeoutMs: 30_000,
      })
      await control.command('click', '[data-testid="smart-apps-section-marketplace"]')
      await control.command('waitFor', '[data-testid="smart-apps-marketplace-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="smart-apps-section-owned"]')
      await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="smart-apps-created-create"]')
      await control.command('waitFor', '[data-testid="smart-app-development-dialog"]', {
        text: '创建空白工作台',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="smart-app-development-display-name"]', {
        value: '空白 E2E 工作台',
      })
      await control.command('fill', '[data-testid="smart-app-development-name"]', {
        value: CREATED_INSTALLATION_ID,
      })
      await control.command('fill', '[data-testid="smart-app-development-parent-path"]', {
        value: resultDir,
      })
      await control.command('fill', '[data-testid="smart-app-development-description"]', {
        value: '验证 Web 预设、持续开发和文件夹运行',
      })
      await captureScreenshot(control, 'harness-apps-03a-create-web-preset.png', 'body')
      await control.command('clickWhenEnabled', '[data-testid="smart-app-development-confirm"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="chat-message-input"]', {
        text: '智能工作台开发助手',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="smart-app-development-preview"]', {
        text: 'DSH 开发预览',
        timeoutMs: uiTimeoutMs,
      })
      const initialPreviewText = await control.command(
        'getText',
        '[data-testid="smart-app-development-preview"]'
      )
      assert.ok(
        initialPreviewText.includes('正在准备运行环境和已配置插件') ||
          initialPreviewText.includes('文件改动后可重新加载'),
        `DSH development preview showed an unexpected initial state: ${initialPreviewText}`
      )
      assert.equal(initialPreviewText.includes('开始浏览'), false)
      assert.equal(initialPreviewText.includes('输入 URL 以打开页面'), false)
      await captureScreenshot(control, 'harness-apps-03b0-dsh-initial-state.png', 'body')
      await control.command('waitFor', '[data-testid="smart-app-development-preview"]', {
        text: '文件改动后可重新加载',
        timeoutMs: 120_000,
      })
      const blankWorkbenchSnapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      assert.equal(blankWorkbenchSnapshot.workbench?.currentProject, null)
      assert.equal(
        blankWorkbenchSnapshot.workbench?.standaloneWorkspacePath,
        join(resultDir, CREATED_INSTALLATION_ID)
      )
      const developmentTaskTabTestId = await control.command(
        'getAttribute',
        '[data-tab-kind="task"][aria-selected="true"]',
        { value: 'data-testid' }
      )
      assert.ok(
        developmentTaskTabTestId,
        'Smart app development preview did not expose its owning task tab'
      )
      const developmentTaskTabId = developmentTaskTabTestId.replace('workspace-tab-select-', '')
      const developmentPreviewSelector =
        `[data-testid="workspace-tab-content-${developmentTaskTabId}"] ` +
        '[data-testid="smart-app-development-preview"]'
      const developmentBrowserSelector =
        `${developmentPreviewSelector} ` + '[data-embedded-browser-label]'
      await control.command('waitFor', developmentBrowserSelector, {
        timeoutMs: uiTimeoutMs,
      })
      const developmentBrowserLabel = await control.command(
        'getAttribute',
        developmentBrowserSelector,
        { value: 'data-embedded-browser-label' }
      )
      assert.ok(
        developmentBrowserLabel,
        'Smart app development preview did not expose its native browser label'
      )
      await captureScreenshot(control, 'harness-apps-03b-builder-chat.png', 'body')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="smart-app-development-preview-reload"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add-task"]')
      const secondTaskStartedAt = Date.now()
      let secondTaskTabTestId = ''
      while (Date.now() - secondTaskStartedAt < uiTimeoutMs) {
        secondTaskTabTestId = await control.command(
          'getAttribute',
          '[data-tab-kind="task"][aria-selected="true"]',
          { value: 'data-testid' }
        )
        if (secondTaskTabTestId && secondTaskTabTestId !== developmentTaskTabTestId) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.ok(
        secondTaskTabTestId && secondTaskTabTestId !== developmentTaskTabTestId,
        'Opening another task did not make the Smart app development task inactive'
      )
      const secondTaskTabId = secondTaskTabTestId.replace('workspace-tab-select-', '')
      await waitForElementCount(
        control,
        `[data-testid="workspace-tab-content-${secondTaskTabId}"] ` +
          '[data-testid="smart-app-development-preview"]',
        0,
        uiTimeoutMs,
        'The new task rendered the inactive Smart app development preview'
      )
      await waitForEmbeddedBrowserVisibility(
        control,
        developmentBrowserLabel,
        false,
        120_000,
        'The inactive Smart app preview reclaimed the native browser after reloading'
      )
      await captureScreenshot(control, 'harness-apps-03b2-preview-task-scoped.png', 'body')
      await control.command('click', `[data-testid="${developmentTaskTabTestId}"]`)
      await control.command(
        'waitFor',
        `[data-testid="${developmentTaskTabTestId}"][aria-selected="true"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid="smart-app-development-preview"]', {
        text: '文件改动后可重新加载',
        stableMs: 500,
        timeoutMs: 120_000,
      })
      await waitForEmbeddedBrowserVisibility(
        control,
        developmentBrowserLabel,
        true,
        uiTimeoutMs,
        'Returning to the Smart app development task did not restore its native browser'
      )
      const developmentBrowserTabSelector =
        '[role="tab"][data-testid^="right-workspace-browser-tab-"]'
      await control.command('waitFor', developmentBrowserTabSelector, {
        text: '空白 E2E 工作台',
        timeoutMs: uiTimeoutMs,
      })
      const developmentBrowserTabTestId = await control.command(
        'getAttribute',
        developmentBrowserTabSelector,
        { value: 'data-testid' }
      )
      assert.ok(
        developmentBrowserTabTestId,
        'The restored Smart app preview did not expose its right-workspace tab identity'
      )
      await control.command(
        'waitFor',
        `[data-testid="${developmentBrowserTabTestId}-close-button"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      for (const action of ['add-plugins', 'refresh', 'reload']) {
        await control.command(
          'waitFor',
          `[data-testid="smart-app-development-preview-${action}"]`,
          {
            enabled: true,
            timeoutMs: uiTimeoutMs,
          }
        )
      }
      await control.command(
        'waitFor',
        '[data-testid="smart-app-development-preview-verification-unverified"]',
        {
          text: '尚未验证',
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'clickWhenEnabled',
        '[data-testid="smart-app-development-preview-verify"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        '[data-testid="smart-app-development-preview-verification-passed"]',
        {
          text: '验证通过',
          timeoutMs: 120_000,
        }
      )
      await captureScreenshot(control, 'harness-apps-03b2-verification-passed.png', 'body')
      await control.command('click', `[data-testid="workspace-tab-close-${secondTaskTabId}"]`)
      await captureScreenshot(control, 'harness-apps-03b2-dsh-reloaded.png', 'body')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="smart-app-development-preview-add-plugins"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid="smart-app-plugin-dialog"]', {
        text: '添加 DSH 插件',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-03b3-add-plugin-dialog.png', 'body')
      await control.command('fill', '[data-testid="smart-app-plugin-spec-input"]', {
        value: localDshPluginPath,
      })
      await control.command('waitFor', '[data-testid="smart-app-plugin-confirm"]', {
        enabled: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('deferredClick', '[data-testid="smart-app-plugin-confirm"]')
      const linkedManifest = await waitForManifestPlugin(
        join(resultDir, CREATED_INSTALLATION_ID, 'plugin-manifest.json'),
        'file:plugins/wework-e2e-local-dsh-plugin',
        120_000
      )
      await waitForElementCount(
        control,
        '[data-testid="smart-app-plugin-dialog"]',
        0,
        120_000,
        'Smart app plugin dialog did not close after installation'
      )
      await control.command('waitFor', '[data-testid="smart-app-development-preview"]', {
        text: '文件改动后可重新加载',
        stableMs: 500,
        timeoutMs: 120_000,
      })
      await control.command(
        'waitFor',
        '[data-testid="smart-app-development-preview-verification-stale"]',
        {
          text: '验证已过期',
          timeoutMs: uiTimeoutMs,
        }
      )
      assert.deepEqual(linkedManifest.plugins, [
        {
          spec: 'file:plugins/wework-e2e-local-dsh-plugin',
          path: 'plugins/wework-e2e-local-dsh-plugin',
        },
      ])
      await access(
        join(
          resultDir,
          CREATED_INSTALLATION_ID,
          'plugins/wework-e2e-local-dsh-plugin/cordis.patch.yml'
        )
      )
      await captureScreenshot(control, 'harness-apps-03b4-plugin-reloaded.png', 'body')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="smart-app-development-preview-verify"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        '[data-testid="smart-app-development-preview-verification-passed"]',
        {
          text: '验证通过',
          timeoutMs: 120_000,
        }
      )
      await captureScreenshot(control, 'harness-apps-03b4-verification-refreshed.png', 'body')
      const developmentWorkspaceTabId = await control.command(
        'getAttribute',
        '[data-workspace-tab-content][aria-hidden="false"]',
        { value: 'data-workspace-tab-content' }
      )
      assert.ok(
        developmentWorkspaceTabId,
        'Smart app development page did not expose its workspace tab ID'
      )
      await control.command(
        'click',
        `[data-testid="workspace-tab-close-${developmentWorkspaceTabId}"]`
      )
      await waitForElementCount(
        control,
        '[data-testid="smart-app-development-preview"]',
        0,
        uiTimeoutMs,
        'Closing the development workspace tab left its browser preview mounted'
      )
      await captureScreenshot(control, 'harness-apps-03b5-development-tab-closed.png', 'body')
      await control.command('navigate', 'body', {
        value: '/sites?app_type=smart_app&view=owned',
      })
      await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
        timeoutMs: 60_000,
      })
      await control.command(
        'waitFor',
        `[data-testid="smart-app-created-item-${CREATED_INSTALLATION_ID}"]`,
        {
          text: '空白 E2E 工作台',
          timeoutMs: uiTimeoutMs,
        }
      )
      await captureScreenshot(control, 'harness-apps-03c-linked-web-workbench.png', 'body')
      await control.command('click', `[data-testid="smart-app-actions-${CREATED_INSTALLATION_ID}"]`)
      await control.command(
        'waitFor',
        `[data-testid="smart-app-add-plugins-${CREATED_INSTALLATION_ID}"]`,
        {
          text: '添加 DSH 插件',
          timeoutMs: uiTimeoutMs,
        }
      )
      await captureScreenshot(control, 'harness-apps-03d-development-actions.png', 'body')
      await control.command(
        'waitFor',
        `[data-testid="smart-app-export-package-${CREATED_INSTALLATION_ID}"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        `[data-testid="smart-app-export-package-${CREATED_INSTALLATION_ID}"]`
      )
      await control.command('waitFor', '[data-testid="smart-app-export-success"]', {
        text: '安装包已导出到下载目录',
        timeoutMs: 120_000,
      })
      await captureScreenshot(control, 'harness-apps-03f-linked-exported.png', 'body')
      await control.command('click', `[data-testid="smart-app-actions-${CREATED_INSTALLATION_ID}"]`)
      await control.command(
        'waitFor',
        `[data-testid="smart-app-remove-local-${CREATED_INSTALLATION_ID}"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        `[data-testid="smart-app-remove-local-${CREATED_INSTALLATION_ID}"]`
      )
      await control.command('waitFor', '[data-testid="smart-app-remove-local-confirm"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="smart-app-remove-local-confirm"]')
      await waitForElementCount(
        control,
        `[data-testid="smart-app-created-item-${CREATED_INSTALLATION_ID}"]`,
        0,
        uiTimeoutMs,
        'Unlinking an editable workbench left its card visible in My'
      )
      await access(join(resultDir, CREATED_INSTALLATION_ID, 'plugin-manifest.json'))
      await captureScreenshot(control, 'harness-apps-03g-linked-folder-preserved.png', 'body')
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
          text: 'DSH E2E Smoke 0.1.0-rc.8',
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
      await control.command('dropPaths', '[data-testid="smart-apps-owned-page"]', {
        value: JSON.stringify([
          {
            uri: pathToFileURL(importedPackagePath).href,
            name: 'dsh-e2e-smoke-imported.zip',
            mimeType: 'application/zip',
          },
        ]),
      })
      await control.command(
        'waitFor',
        `[data-testid="smart-app-created-item-${IMPORTED_INSTALLATION_ID}"]`,
        {
          text: 'DSH E2E Smoke 0.1.0-rc.8',
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid="smart-apps-import-button"]', {
        enabled: true,
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('navigate', 'body', {
        value: '/sites?app_type=smart_app&view=owned',
      })
      await control.command('waitFor', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="smart-apps-section-owned"]', {
        text: '我的',
        timeoutMs: uiTimeoutMs,
      })
      const harnessManagementSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        harnessManagementSnapshot.location.includes('app_type=smart_app') &&
          harnessManagementSnapshot.location.includes('view=owned'),
        `My Smart apps did not open: ${harnessManagementSnapshot.location}`
      )
      const managementTabId = await control.command(
        'getAttribute',
        '[data-workspace-tab-content][aria-hidden="false"]',
        { value: 'data-workspace-tab-content' }
      )
      assert.ok(managementTabId, 'Harness management page did not expose its workspace tab ID')
      const activeWorkspaceContentSelector = '[data-workspace-tab-content][aria-hidden="false"]'
      assert.ok(sharedSmartAppId, 'Shared Smart app fixture did not expose its catalog ID')
      const sharedVisibilitySelector =
        `${activeWorkspaceContentSelector} ` +
        `[data-testid="smart-app-visibility-${sharedSmartAppId}"]`
      await control.command('click', sharedVisibilitySelector)
      await control.command('waitFor', '[data-testid="smart-app-share-dialog"]', {
        text: '管理范围',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="smart-app-share-scope-public"]')
      await control.command('waitFor', '[data-testid="smart-app-share-dialog"]', {
        text: '本地后续修改不会自动同步',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', '[data-testid="smart-app-share-save"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="smart-app-access-success"]', {
        text: 'v0.0.9 已上架到智能应用市场。',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-05a-public-snapshot-listed.png', 'body')
      await control.command('click', '[data-testid="smart-app-access-view-marketplace"]')
      await control.command(
        'waitFor',
        `${activeWorkspaceContentSelector} ` +
          `[data-testid="smart-app-marketplace-item-${sharedSmartAppId}"]`,
        {
          text: '我发布的',
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        `${activeWorkspaceContentSelector} [data-testid="smart-apps-section-owned"]`
      )
      await control.command('waitFor', sharedVisibilitySelector, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', sharedVisibilitySelector)
      await control.command('waitFor', '[data-testid="smart-app-share-dialog"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="smart-app-share-scope-private"]')
      await control.command('clickWhenEnabled', '[data-testid="smart-app-share-save"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="smart-app-access-success"]', {
        text: '分享范围已保存。',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-05-installed.png', 'body')
      await control.command('click', `[data-testid="smart-app-actions-${INSTALLATION_ID}"]`)
      await control.command(
        'waitFor',
        `[data-testid="smart-app-export-package-${INSTALLATION_ID}"]`,
        {
          text: '导出安装包',
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('click', `[data-testid="smart-app-export-package-${INSTALLATION_ID}"]`)
      await control.command('waitFor', '[data-testid="smart-app-export-success"]', {
        text: '安装包已导出到下载目录。',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-05a-exported.png', 'body')

      const importedModelSelector = `[data-testid="harness-app-model-${IMPORTED_INSTALLATION_ID}"]`
      await control.command('select', importedModelSelector, {
        by: 'label',
        value: MODEL_LABEL,
      })
      await control.command('waitFor', importedModelSelector, {
        enabled: true,
        stableMs: 300,
        timeoutMs: 30_000,
      })
      await control.command(
        'clickWhenEnabled',
        `[data-testid="harness-app-start-${IMPORTED_INSTALLATION_ID}"]`,
        {
          timeoutMs: 30_000,
        }
      )
      await control.command(
        'waitFor',
        `[data-testid="harness-app-launch-${IMPORTED_INSTALLATION_ID}"]`,
        {
          timeoutMs: 30_000,
        }
      )
      await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
      await control.command(
        'waitFor',
        `[data-testid="workspace-tab-select-${managementTabId}"][aria-selected="true"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        `[data-testid="app-iframe-harness-${IMPORTED_INSTALLATION_ID}"]`,
        {
          timeoutMs: 600_000,
        }
      )
      await control.command('navigate', 'body', {
        value: '/sites?app_type=smart_app&view=owned',
      })
      await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('navigate', 'body', {
        value: '/sites?app_type=smart_app&view=owned',
      })
      await control.command(
        'waitFor',
        `${activeWorkspaceContentSelector} [data-testid="harness-app-open-${IMPORTED_INSTALLATION_ID}"]`,
        { timeoutMs: 30_000 }
      )
      await control.command(
        'click',
        `${activeWorkspaceContentSelector} [data-testid="smart-app-actions-${IMPORTED_INSTALLATION_ID}"]`
      )
      await control.command(
        'waitFor',
        `[data-testid="smart-app-stop-menu-${IMPORTED_INSTALLATION_ID}"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        `[data-testid="smart-app-stop-menu-${IMPORTED_INSTALLATION_ID}"]`
      )
      await control.command(
        'waitFor',
        `[data-testid="harness-app-start-${IMPORTED_INSTALLATION_ID}"]`,
        {
          timeoutMs: 30_000,
        }
      )

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
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command(
        'waitFor',
        `[data-testid="workspace-tab-add-smart-app-${INSTALLATION_ID}"]`,
        {
          stableMs: 300,
          timeoutMs: uiTimeoutMs,
        }
      )
      await captureScreenshot(control, 'harness-apps-06-direct-add-menu.png', 'body')
      await control.command('press', 'body', { key: 'Escape' })

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
      await control.command(
        'waitFor',
        `[data-testid="workspace-tab-select-${appTabId}"][aria-selected="true"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await captureScreenshot(control, 'harness-apps-08a-workbench-loaded.png', 'body')
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
        visible: true,
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-08b-workbench-add-menu.png', 'body')
      await control.command('press', 'body', { key: 'Escape' })
      await control.command('contextMenu', `[data-testid="workspace-tab-select-${appTabId}"]`)
      await control.command('waitFor', '[data-testid="workspace-tab-context-menu"]', {
        visible: true,
        stableMs: 300,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-08c-workbench-context-menu.png', 'body')
      await control.command('press', 'body', { key: 'Escape' })
      const appWorkspaceSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        appWorkspaceSnapshot.location.includes(APP_ROUTE),
        `Harness app workspace route did not open: ${appWorkspaceSnapshot.location}`
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
      const nativeSnapshot = await control.command('captureEmbeddedBrowser', appSurface, {
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
      await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
      await control.command(
        'waitFor',
        `[data-testid="workspace-tab-select-${managementTabId}"][aria-selected="true"]`,
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
      const managedAppCard = `${activeWorkspaceContentSelector} [data-testid="smart-app-created-item-${INSTALLATION_ID}"]`
      const managedAppOpen = `${managedAppCard} [data-testid="harness-app-open-${INSTALLATION_ID}"]`
      const managedAppStart = `${managedAppCard} [data-testid="harness-app-start-${INSTALLATION_ID}"]`
      const managedAppActions = `${managedAppCard} [data-testid="smart-app-actions-${INSTALLATION_ID}"]`
      await control.command('waitFor', managedAppOpen, {
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
      await control.command('waitFor', managedAppStart, {
        enabled: true,
        timeoutMs: 30_000,
      })
      await control.command('clickWhenEnabled', managedAppStart, {
        timeoutMs: 30_000,
      })
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
      await control.command('waitFor', managedAppOpen, {
        visible: true,
        timeoutMs: 30_000,
      })
      await control.command('click', managedAppActions)
      await control.command('waitFor', `[data-testid="smart-app-stop-menu-${INSTALLATION_ID}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `[data-testid="smart-app-stop-menu-${INSTALLATION_ID}"]`)
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
      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command(
        'waitFor',
        `[data-testid="workspace-tab-add-smart-app-${INSTALLATION_ID}"]`,
        {
          stableMs: 300,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        `[data-testid="workspace-tab-add-smart-app-${INSTALLATION_ID}"]`
      )
      await control.command('waitFor', `[data-testid="harness-app-launch-${INSTALLATION_ID}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', `[data-testid="app-iframe-harness-${INSTALLATION_ID}"]`, {
        timeoutMs: 600_000,
      })
      await captureScreenshot(control, 'harness-apps-11-direct-add-opened.png', 'body')
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command('waitFor', '[data-testid="workspace-tab-add-smart-app"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add-smart-app"]')
      await control.command(
        'click',
        `${activeWorkspaceContentSelector} [data-testid="smart-apps-section-owned"]`
      )
      await control.command('waitFor', managedAppOpen, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', managedAppActions)
      await control.command('waitFor', `[data-testid="smart-app-stop-menu-${INSTALLATION_ID}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `[data-testid="smart-app-stop-menu-${INSTALLATION_ID}"]`)
      await control.command('waitFor', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`, {
        timeoutMs: 30_000,
      })
      await captureScreenshot(control, 'harness-apps-12-direct-add-stopped.png', 'body')

      const marketplaceSectionSelector = `${activeWorkspaceContentSelector} [data-testid="smart-apps-section-marketplace"]`
      await control.command('click', marketplaceSectionSelector)
      await control.command('waitFor', `${marketplaceSectionSelector}[aria-current="page"]`, {
        stableMs: 1000,
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        `${activeWorkspaceContentSelector} [data-testid="smart-apps-marketplace-page"]`,
        {
          stableMs: 1000,
          timeoutMs: uiTimeoutMs,
        }
      )
      const marketplaceActionsSelector = `${activeWorkspaceContentSelector} [data-testid="smart-app-marketplace-actions-1"]`
      await control.command('waitFor', marketplaceActionsSelector, {
        timeoutMs: uiTimeoutMs,
      })
      const returnedMarketplaceSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        returnedMarketplaceSnapshot.location.includes('/sites?app_type=smart_app') &&
          !returnedMarketplaceSnapshot.location.includes('view=owned'),
        `My Smart apps did not return to the marketplace: ${returnedMarketplaceSnapshot.location}`
      )
      await captureScreenshot(control, 'harness-apps-15-returned-to-marketplace.png', 'body')

      await control.command('click', marketplaceActionsSelector)
      await control.command('waitFor', '[data-testid="smart-app-remove-local-market-1"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="smart-app-remove-local-market-1"]')
      await control.command('waitFor', '[data-testid="smart-app-remove-local-confirm"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="smart-app-remove-local-confirm"]')
      await waitForElementCount(
        control,
        '[data-testid="smart-app-marketplace-actions-1"]',
        0,
        uiTimeoutMs,
        'Removing a marketplace installation left its local actions visible'
      )
      await control.command('waitFor', '[data-testid="smart-app-marketplace-item-1-state"]', {
        text: '未安装',
        timeoutMs: uiTimeoutMs,
      })

      await control.command(
        'click',
        `${activeWorkspaceContentSelector} [data-testid="smart-apps-section-owned"]`
      )
      await control.command(
        'waitFor',
        `${activeWorkspaceContentSelector} [data-testid="smart-app-created-item-${IMPORTED_INSTALLATION_ID}"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        `${activeWorkspaceContentSelector} [data-testid="smart-app-actions-${IMPORTED_INSTALLATION_ID}"]`
      )
      await control.command(
        'waitFor',
        `[data-testid="smart-app-remove-local-${IMPORTED_INSTALLATION_ID}"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        `[data-testid="smart-app-remove-local-${IMPORTED_INSTALLATION_ID}"]`
      )
      await control.command('waitFor', '[data-testid="smart-app-remove-local-confirm"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="smart-app-remove-local-confirm"]')
      await waitForElementCount(
        control,
        `${activeWorkspaceContentSelector} [data-testid="smart-app-created-item-${IMPORTED_INSTALLATION_ID}"]`,
        0,
        uiTimeoutMs,
        'Removing an imported workbench left its card visible in My'
      )
      await captureScreenshot(control, 'harness-apps-15a-local-removal-semantics.png', 'body')

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
