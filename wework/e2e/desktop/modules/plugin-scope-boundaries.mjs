import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeCodexConfig } from './desktop-build-flows.mjs'
import { declineInitialTelemetryConsent } from './preferences-automation-flows.mjs'
import {
  completedApiResourceTimings,
  inventory,
  materializedPlugin,
  openComposerPluginPicker,
  requestPluginExecutor,
  testId,
  until,
} from './plugin-regression-fixture.mjs'
import {
  commandOutputAsync,
  createPluginMarketplaceFixture,
  MODEL_API_KEY,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_MARKETPLACE_NAME,
} from './shared.mjs'
import { waitForTestIdByText } from './workspace-flows.mjs'
import { createZipFixture } from './zip-fixtures.mjs'

const clientBundle = process.env.WEWORK_E2E_SOCKET_IO_CLIENT
const { decompressFromUTF16 } = createRequire(import.meta.url)(
  clientBundle ? resolve(dirname(clientBundle), 'lz-string.cjs') : 'lz-string'
)
const storageKey = 'wework.plugins.inventory.v2'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function assertWithin(root, path) {
  const child = relative(root, path)
  assert.ok(child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

export function decodeInventory(raw) {
  assert.ok(raw, 'The real renderer did not persist plugin inventory')
  const json = raw.startsWith('lz:') ? decompressFromUTF16(raw.slice(3)) : raw
  const parsed = JSON.parse(json)
  assert.ok(parsed.entries && typeof parsed.entries === 'object')
  return Object.values(parsed.entries)
}

function hasPlugin(items, slug) {
  return items.some(item => item.pluginKey === slug)
}

function summarize(state) {
  return {
    deviceId: state.sharedInventory.deviceId,
    shared: state.sharedInventory.installedPlugins,
    composer: state.composerApps.map(item => ({ pluginKey: item.pluginKey, source: item.source })),
    local: state.installedPlugins,
  }
}

/** Real account authorization and real device restart; persisted data is never fabricated. */
export async function verifyPluginScopeBoundaries({
  cloud,
  control,
  apiProxy,
  resultDir,
  executorHome,
  electronUserDataDirectory,
  codexSqliteHome,
  homePath,
  restartDesktopApp,
  captureScreenshot,
  workbenchReadyTimeoutMs,
  deviceId,
}) {
  assert.equal(typeof restartDesktopApp, 'function')
  assert.equal(typeof codexSqliteHome, 'string', 'Original SQLite home is required for restoration')
  assert.equal(typeof homePath, 'string', 'Original isolated Home is required for restoration')
  const root = await realpath(resultDir)
  assertWithin(root, await realpath(executorHome))
  assertWithin(root, await realpath(electronUserDataDirectory))
  const reportPath = join(resultDir, 'plugin-scope-boundaries-evidence.json')
  const timeoutMs = Math.min(workbenchReadyTimeoutMs, 30_000)
  const report = {
    scope: 'Actual account authorization and restarted device with byte-identical persisted cache',
    boundaries: [
      'Device isolation is verified across real process/profile restart, not a hot device switch',
      'Account late-response isolation uses one live renderer and exact completed upstream bytes',
    ],
    cases: [],
  }
  const failures = []
  let inDeviceB = false
  let accountMayHaveChanged = false
  let accountA
  let activeCase
  const originalRule = apiProxy.rule
  const originalEnvironment = {
    HOME: homePath,
    WORKSPACE_ROOT: join(homePath, '.wegent', 'workspace'),
    WEGENT_STANDALONE_WORKSPACE_ROOT: join(homePath, 'Documents', 'Codex'),
    WEGENT_EXECUTOR_HOME: executorHome,
    WEGENT_CODEX_HOME: join(executorHome, 'codex'),
    CODEX_SQLITE_HOME: codexSqliteHome,
    WEWORK_APP_CONFIG_DIR: join(homePath, 'app-config'),
    WEWORK_USER_DATA_DIR: electronUserDataDirectory,
    WEWORK_E2E_CODEX_HOME_INITIALIZATION: 'false',
  }

  async function request(path, { token = cloud.authToken, method = 'GET', body } = {}) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    assert.ok(response.ok, `${method} ${path.split('?')[0]}: HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }

  async function backToCatalog() {
    await control.command('waitFor', testId('plugins-button'), {
      visible: true,
      enabled: true,
      stableMs: 250,
    })
    await control.command('click', testId('plugins-button'), { visible: true })
    for (const id of ['plugin-management-back-button', 'plugin-detail-back-button']) {
      if (Number(await control.command('getElementCount', testId(id))) > 0) {
        await control.command('click', testId(id))
      }
    }
    await control.command('waitFor', testId('plugins-search-input'))
    await control.command('fill', testId('plugins-search-input'), { value: '' })
  }

  async function refreshCatalog() {
    await backToCatalog()
    await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
  }

  async function openComposer() {
    await control.command('click', testId('new-chat-button'), { visible: true })
    await openComposerPluginPicker(control)
  }

  async function closeComposerPicker() {
    const button = testId('composer-plugin-picker-button')
    if (Number(await control.command('getElementCount', button, { visible: true }))) {
      const expanded = await control.command('getAttribute', button, {
        value: 'aria-expanded',
        visible: true,
      })
      if (expanded === 'true') await control.command('click', button, { visible: true })
    }
    await control.command('waitFor', testId('composer-plugin-picker'), { visible: false })
  }

  async function assertViews(slug, present, currentDeviceId) {
    const observation = { slug, expectedPresent: present, expectedDeviceId: currentDeviceId }
    if (activeCase) activeCase.lastViewAssertion = observation
    await backToCatalog()
    await control.command('click', testId('plugins-manage-button'))
    await control.command(
      'waitFor',
      `${testId('plugin-management-installed-list')}, ${testId('plugin-management-empty-state')}`
    )
    await until(
      async () => {
        const text = await control.command('getText', testId('plugin-management-page-content'))
        observation.managerContainsPlugin = text.includes(slug)
        return text
      },
      text => text.includes(slug) === present,
      `Management page has unexpected membership for ${slug}`
    )
    await openComposer()
    const state = await until(
      async () => {
        const current = await inventory(control)
        observation.actual = summarize(current)
        return current
      },
      value =>
        value.sharedInventory.deviceId === currentDeviceId &&
        hasPlugin(value.sharedInventory.installedPlugins, slug) === present &&
        hasPlugin(value.composerApps, slug) === present,
      `Current shared inventory and composer have unexpected membership for ${slug}`,
      timeoutMs
    )
    await control.command('fill', testId('composer-plugin-picker-search'), { value: slug })
    const picker = JSON.parse(await control.command('snapshot', testId('composer-plugin-picker')))
    assert.equal(
      picker.testIds.includes(`composer-plugin-picker-item-plugin:${slug}`),
      present,
      'Visible composer picker disagrees with current inventory'
    )
    await closeComposerPicker()
    return summarize(state)
  }

  async function runCase(name, action) {
    const result = { name, passed: false }
    report.cases.push(result)
    activeCase = result
    try {
      Object.assign(result, await action(result))
      result.passed = true
    } catch (error) {
      result.error = String(error.message ?? error)
      failures.push(new Error(`${name}: ${result.error}`, { cause: error }))
    } finally {
      try {
        await captureScreenshot(control, `plugin-scope-${name}.png`)
      } catch (error) {
        result.screenshotError = String(error.message ?? error)
        result.passed = false
        failures.push(error)
      }
      try {
        await closeComposerPicker()
      } catch (error) {
        result.menuCleanupError = String(error.message ?? error)
        result.passed = false
        failures.push(error)
      }
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
      activeCase = undefined
    }
  }

  async function authSessionKeys() {
    const output = await commandOutputAsync('redis-cli', [
      '-p',
      String(cloud.redisPort),
      '--raw',
      '--scan',
      '--pattern',
      '*wework_auth_session:*',
    ])
    return output.split('\n').filter(Boolean)
  }

  async function authorizeAccount(user, token) {
    await control.command('navigate', 'body', { value: '/settings/connections' })
    await control.command(
      'waitFor',
      `${testId('settings-cloud-disconnect-button')}, ${testId('settings-cloud-connect-button')}`,
      { visible: true, enabled: true, stableMs: 250 }
    )
    if (
      Number(
        await control.command('getElementCount', testId('settings-cloud-disconnect-button'), {
          visible: true,
        })
      )
    ) {
      await control.command('click', testId('settings-cloud-disconnect-button'), { visible: true })
    }
    await control.command('waitFor', testId('settings-cloud-connect-button'), {
      visible: true,
      enabled: true,
      stableMs: 250,
    })
    const before = new Set(await authSessionKeys())
    await control.command('click', testId('settings-cloud-connect-button'))
    await control.command('waitFor', testId('cloud-backend-url-input'))
    await control.command('fill', testId('cloud-backend-url-input'), { value: apiProxy.url })
    await control.command('clickWhenEnabled', testId('cloud-authorization-submit-button'))
    const key = await until(
      authSessionKeys,
      keys => keys.some(value => !before.has(value)),
      'Real cloud authorization did not create a new Redis session'
    )
    const created = key.filter(value => !before.has(value))
    assert.equal(created.length, 1, 'The account switch created ambiguous authorization sessions')
    const sessionId = created[0].split('wework_auth_session:').at(-1)
    assert.match(sessionId, /^[a-f0-9-]{36}$/)
    const approved = await request(`/auth/wework/sessions/${sessionId}/approve`, {
      token,
      method: 'POST',
    })
    assert.equal(approved.status, 'approved')
    await control.command('waitFor', testId('cloud-connection-status-card'), {
      text: user.user_name,
      visible: true,
      timeoutMs,
    })
    const connectedCard = await control.command('getText', testId('cloud-connection-status-card'), {
      visible: true,
    })
    assert.ok(
      connectedCard.includes(user.user_name),
      'The real connection card has the wrong account'
    )
    await control.command('click', testId('settings-back-button'), { visible: true })
    await control.command('waitFor', testId('desktop-sidebar-account'), {
      text: user.user_name,
      visible: true,
    })
    if (activeCase) {
      activeCase.lastAuthorizedAccount = {
        id: user.id,
        userName: user.user_name,
        connectionCardVerified: true,
        workbenchSidebarVerified: true,
      }
    }
  }

  async function importPersonal(slug) {
    const directory = join(resultDir, 'plugin-scope-personal-fixture')
    await mkdir(directory, { recursive: true })
    const archivePath = join(directory, `${slug}.zip`)
    const bundled = JSON.parse(await control.command('getBundledPluginUpdates', 'body'))
    assert.equal(typeof bundled.marketplace?.path, 'string')
    const marketplacePath = await realpath(bundled.marketplace.path)
    assertWithin(root, marketplacePath)
    const skill = `---\nname: ${slug}\ndescription: Only device A owns this personal plugin.\n---\n`
    await createZipFixture(archivePath, {
      '.codex-plugin/plugin.json': JSON.stringify({
        name: slug,
        version: '1.0.0',
        description: 'Only device A owns this personal plugin',
        author: { name: 'Wework Desktop E2E' },
        skills: './skills/',
        interface: {
          displayName: slug,
          shortDescription: 'Real device boundary regression marker',
          longDescription: 'This package is imported locally and never installed in the cloud.',
          developerName: 'Desktop E2E',
          category: 'Developer Tools',
          capabilities: ['Skills'],
          defaultPrompt: 'Verify device boundaries.',
        },
      }),
      [`skills/${slug}/SKILL.md`]: skill,
    })
    const preview = JSON.parse(
      await control.command('previewPluginImport', 'body', {
        value: JSON.stringify({ archivePath, marketplacePath }),
      })
    )
    if (activeCase) {
      activeCase.personalPackagePreview = { valid: preview.valid, issues: preview.issues }
    }
    assert.equal(
      preview.valid,
      true,
      `The actual personal package failed import validation: ${JSON.stringify(preview.issues)}`
    )
    const imported = JSON.parse(
      await control.command('importPluginPackage', 'body', {
        value: JSON.stringify({ preview, overwrite: false }),
      })
    )
    assert.equal(imported.pluginName, slug)
    const skillPath = join(marketplacePath, 'plugins', slug, 'skills', slug, 'SKILL.md')
    assertWithin(root, await realpath(skillPath))
    assert.equal(await readFile(skillPath, 'utf8'), skill)
    return { slug, marketplacePath, skillPath, skillSha256: sha256(skill) }
  }

  async function persistedMarker(slug) {
    const raw = await control.command('getLocalStorageItem', 'body', { value: storageKey })
    if (!raw) return null
    const entry = decodeInventory(raw).find(
      snapshot =>
        snapshot.deviceId === deviceId &&
        snapshot.installedPlugins.some(plugin => plugin.spec.source.pluginKey === slug)
    )
    return entry ? { sha256: sha256(raw), deviceId: entry.deviceId, slug } : null
  }

  async function restoreDeviceA() {
    apiProxy.rule = originalRule
    await restartDesktopApp({
      appEnvironmentOverrides: originalEnvironment,
      expectNewDeviceIdentity: true,
    })
    inDeviceB = false
    await control.command('waitFor', testId('plugins-button'), {
      visible: true,
      enabled: true,
      stableMs: 250,
      timeoutMs,
    })
    const status = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
    assert.equal(status.deviceId, deviceId, 'The original real device identity was not restored')
    await refreshCatalog()
  }

  try {
    accountA = await request('/users/me')
    await runCase('device-persisted-cache', async result => {
      const slug = `scope-personal-device-a-${process.pid}`
      const personal = await importPersonal(slug)
      const cloudBefore = await request('/plugins/installed')
      assert.ok(!cloudBefore.items.some(item => item.spec.source.pluginKey === slug))
      await refreshCatalog()
      const before = await assertViews(slug, true, deviceId)
      const cache = await until(
        () => persistedMarker(slug),
        Boolean,
        'The personal marker never reached real persisted renderer inventory'
      )
      Object.assign(result, {
        marker: { slug, skillSha256: personal.skillSha256, cloudMembership: false },
        cache,
        before,
        deviceA: deviceId,
      })
      const deviceRoot = join(resultDir, `plugin-scope-device-b-${randomUUID()}`)
      const bHome = join(deviceRoot, 'home')
      const bExecutor = join(deviceRoot, 'executor-home')
      const bCodex = join(bExecutor, 'codex')
      const bUserData = join(deviceRoot, 'electron-user-data')
      const bSqlite = join(deviceRoot, 'codex-sqlite')
      for (const path of [bHome, bExecutor, bCodex, bUserData, bSqlite]) {
        await mkdir(path, { recursive: true, mode: 0o700 })
        assertWithin(root, await realpath(path))
      }
      await writeCodexConfig(bCodex, control.url, '[features]\nplugins = true\n')
      await writeFile(
        join(bCodex, 'auth.json'),
        JSON.stringify({ OPENAI_API_KEY: MODEL_API_KEY }),
        {
          flag: 'wx',
          mode: 0o600,
        }
      )
      const bId = `electron-${randomUUID()}`
      await writeFile(join(bUserData, 'desktop-device-id'), bId, { flag: 'wx', mode: 0o600 })
      const copiedStorage = []
      Object.assign(result, { deviceB: bId, copiedStorage })
      const faultStart = apiProxy.requests.length
      apiProxy.rule = entry =>
        entry.method === 'GET' && entry.path === '/api/plugins/installed'
          ? 'disconnect'
          : originalRule(entry)
      inDeviceB = true
      await restartDesktopApp({
        expectNewDeviceIdentity: true,
        appEnvironmentOverrides: {
          HOME: bHome,
          WORKSPACE_ROOT: join(bHome, '.wegent', 'workspace'),
          WEGENT_STANDALONE_WORKSPACE_ROOT: join(bHome, 'Documents', 'Codex'),
          WEGENT_EXECUTOR_HOME: bExecutor,
          WEGENT_CODEX_HOME: bCodex,
          CODEX_SQLITE_HOME: bSqlite,
          WEWORK_APP_CONFIG_DIR: join(bHome, 'app-config'),
          WEWORK_USER_DATA_DIR: bUserData,
          WEWORK_E2E_CODEX_HOME_INITIALIZATION: 'false',
        },
        afterStop: async () => {
          for (const name of [
            'renderer-local-storage.json',
            'renderer-local-storage-origins.json',
          ]) {
            const source = join(electronUserDataDirectory, name)
            const metadata = await lstat(source)
            assert.ok(metadata.isFile() && !metadata.isSymbolicLink())
            assertWithin(root, await realpath(source))
            const bytes = await readFile(source)
            if (name === 'renderer-local-storage.json') {
              const persisted = JSON.parse(bytes).entries[storageKey]
              assert.ok(
                decodeInventory(persisted).some(
                  snapshot =>
                    snapshot.deviceId === deviceId &&
                    snapshot.installedPlugins.some(item => item.spec.source.pluginKey === slug)
                ),
                'Stopped device A did not durably serialize its actual personal plugin cache'
              )
            }
            const target = join(bUserData, name)
            await copyFile(source, target, constants.COPYFILE_EXCL)
            assert.deepEqual(await readFile(target), bytes, 'Device migration changed cache bytes')
            copiedStorage.push({ name, bytes: bytes.length, sha256: sha256(bytes) })
          }
        },
      })
      await declineInitialTelemetryConsent(control)
      await control.command('waitFor', testId('plugins-button'), {
        visible: true,
        enabled: true,
        stableMs: 250,
        timeoutMs,
      })
      const status = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
      assert.equal(status.deviceId, bId)
      assert.notEqual(status.deviceId, deviceId)
      await refreshCatalog()
      await until(
        () => apiProxy.requests.slice(faultStart),
        entries => entries.some(entry => entry.fault === 'disconnect'),
        'Device B did not exercise a real failing cloud inventory read'
      )
      const duringFault = await assertViews(slug, false, bId)
      result.duringFault = duringFault
      assert.ok(!hasPlugin(duringFault.local, slug), 'A local package leaked into B executor reads')
      await backToCatalog()
      await control.command('click', testId('plugins-manage-button'))
      await control.command(
        'waitFor',
        `${testId('plugin-operation-notice')}[data-notice-kind="error"]`
      )
      const bBundled = JSON.parse(await control.command('getBundledPluginUpdates', 'body'))
      const bMarketplace = await realpath(bBundled.marketplace.path)
      assertWithin(await realpath(deviceRoot), bMarketplace)
      await assert.rejects(lstat(join(bMarketplace, 'plugins', slug)), { code: 'ENOENT' })
      const manifestPath = join(bExecutor, 'capabilities', 'manifest-v2.json')
      assertWithin(await realpath(deviceRoot), await realpath(manifestPath))
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      assert.ok(
        !Object.entries(manifest.plugins ?? {}).some(
          ([key, item]) => key.includes(slug) || item.name === slug
        )
      )
      await captureScreenshot(control, 'plugin-scope-device-b-cloud-read-failure.png')
      const recoveryStart = apiProxy.requests.length
      apiProxy.rule = originalRule
      await refreshCatalog()
      await until(
        () => apiProxy.requests.slice(recoveryStart),
        entries =>
          entries.some(
            entry =>
              entry.method === 'GET' &&
              entry.path === '/api/plugins/installed' &&
              entry.status === 200 &&
              !entry.fault
          ),
        'Explicit device B refresh did not recover through the real cloud API',
        timeoutMs
      )
      const recoveredB = await assertViews(slug, false, bId)
      result.recoveredB = recoveredB

      // A healthy cold load must publish later local catalog data after replacing
      // the original A cache. A manual refresh or opening management first would
      // repair the baseline and mask the cross-device response rejection.
      const bLocalMarket = join(deviceRoot, 'local-marketplace')
      await createPluginMarketplaceFixture(bLocalMarket)
      const registered = await requestPluginExecutor(control, 'codex.app_server_request', {
        method: 'marketplace/add',
        params: { source: bLocalMarket, refName: null, sparsePaths: null },
      })
      assert.equal(registered.status, 200)
      assert.equal(registered.payload.ok, true)
      assert.equal(registered.payload.result.marketplaceName, PLUGIN_MARKETPLACE_NAME)
      const cloudMarker = await cloud.publishPluginRelease({
        slug: `scope-healthy-device-b-${process.pid}`,
        version: '1.0.0',
        skills: { 'healthy-device-check': 'Healthy cloud catalog beside the local catalog' },
      })
      await restartDesktopApp({
        afterStop: async () => {
          for (const copied of copiedStorage) {
            const source = join(electronUserDataDirectory, copied.name)
            const target = join(bUserData, copied.name)
            for (const path of [source, target]) {
              const metadata = await lstat(path)
              assert.ok(metadata.isFile() && !metadata.isSymbolicLink())
              assertWithin(root, await realpath(path))
            }
            assert.equal(sha256(await readFile(source)), copied.sha256)
            await copyFile(source, target)
            assert.deepEqual(await readFile(target), await readFile(source))
          }
        },
      })
      await backToCatalog()
      await control.command('waitFor', testId(`plugin-marketplace-row-${cloudMarker.pluginId}`), {
        timeoutMs,
      })
      const localCatalogRow = await waitForTestIdByText(
        control,
        'body',
        'plugin-marketplace-row-',
        PLUGIN_DISPLAY_NAME,
        timeoutMs
      )
      result.healthyColdLoad = {
        deviceId: bId,
        localCatalogRow,
        cloudPluginId: cloudMarker.pluginId,
      }
      await assertViews(slug, false, bId)
      await captureScreenshot(control, 'plugin-scope-device-b-healthy-cold-catalog.png')
      await restoreDeviceA()
      const restoredA = await assertViews(slug, true, deviceId)
      assert.equal(sha256(await readFile(personal.skillPath)), personal.skillSha256)
      return {
        marker: { slug, skillSha256: personal.skillSha256, cloudMembership: false },
        cache,
        copiedStorage,
        deviceA: deviceId,
        deviceB: bId,
        before,
        duringFault,
        recoveredB,
        healthyColdLoad: result.healthyColdLoad,
        restoredA,
      }
    })
    await runCase('account-late-response', async result => {
      if (inDeviceB) await restoreDeviceA()
      const userName = `scope-account-b-${process.pid}`
      const password = `desktop-e2e-${randomUUID()}`
      const accountB = await request('/admin/users', {
        method: 'POST',
        body: { user_name: userName, password, role: 'user', auth_source: 'password' },
      })
      const login = await request('/auth/login', {
        method: 'POST',
        body: { user_name: userName, password },
      })
      assert.equal(typeof login.access_token, 'string')
      const slugA = `scope-cloud-account-a-${process.pid}`
      const slugB = `scope-cloud-account-b-${process.pid}`
      const markers = []
      Object.assign(result, {
        accountA: { id: accountA.id, userName: accountA.user_name },
        accountB: { id: accountB.id, userName: accountB.user_name },
        markers,
      })
      for (const [slug, token, currentDevice] of [
        [slugA, cloud.authToken, deviceId],
        [slugB, login.access_token, null],
      ]) {
        const release = await cloud.publishPluginRelease({
          slug,
          version: '1.0.0',
          skills: { [slug]: 'Real cloud account boundary fixture' },
        })
        await request(
          `/plugins/marketplace/${release.pluginId}/install${
            currentDevice ? `?device_id=${encodeURIComponent(currentDevice)}` : ''
          }`,
          { token, method: 'POST' }
        )
        const membership = await request('/plugins/installed', { token })
        const plugin = membership.items.find(item => item.spec.source.pluginKey === slug)
        assert.ok(plugin, 'The real account marker installation is missing')
        markers.push({
          slug,
          pluginId: release.pluginId,
          installedId: Number(plugin.metadata.labels.id),
        })
      }
      await refreshCatalog()
      const before = await assertViews(slugA, true, deviceId)
      await assertViews(slugB, false, deviceId)
      await until(
        () => materializedPlugin(executorHome, markers[0].installedId),
        Boolean,
        'The account A marker never materialized in the real executor',
        timeoutMs
      )
      await completedApiResourceTimings(control, '/api/plugins/installed')
      const requestStart = apiProxy.requests.length
      let claimed = false
      apiProxy.rule = entry => {
        if (!claimed && entry.method === 'GET' && entry.path === '/api/plugins/installed') {
          claimed = true
          return 'hold-response'
        }
        return originalRule(entry)
      }
      const heldStartedAt = Date.now()
      await refreshCatalog()
      const pending = await until(
        () => apiProxy.requests.slice(requestStart).find(entry => entry.committedResponseHeld),
        Boolean,
        'The real account A inventory response was not fully received and held'
      )
      const heldReadyAt = Date.now()
      assert.equal(pending.status, 200)
      result.heldResponse = {
        requestIndex: apiProxy.requests.indexOf(pending),
        status: pending.status,
        fullyReceived: pending.committedResponseHeld,
      }
      accountMayHaveChanged = true
      await authorizeAccount(accountB, login.access_token)
      await refreshCatalog()
      const beforeRelease = await assertViews(slugB, true, deviceId)
      result.beforeRelease = beforeRelease
      await assertViews(slugA, false, deviceId)
      const releasedAt = Date.now()
      assert.equal(
        await pending.release(),
        true,
        'The actual old-account response was canceled rather than released'
      )
      assert.equal(pending.released, true)
      result.heldResponse.released = true
      const consumed = await until(
        async () => {
          const matching = (
            await completedApiResourceTimings(control, '/api/plugins/installed')
          ).filter(
            entry =>
              entry.startedAt >= heldStartedAt &&
              entry.startedAt <= heldReadyAt &&
              entry.completedAt >= releasedAt
          )
          assert.ok(
            matching.length <= 1,
            'A parallel slow request makes old-response timing ambiguous'
          )
          return matching[0]
        },
        Boolean,
        'The renderer never finished consuming the actual released old-account response'
      )
      result.heldResponse.rendererCompleted = consumed
      // Observe without navigation/refresh so a fresh read cannot repair a stale overwrite.
      const stabilityStartedAt = Date.now()
      const stability = []
      result.heldResponse.stableInventorySamples = stability
      await until(
        async () => {
          const current = await inventory(control)
          assert.equal(current.sharedInventory.deviceId, deviceId)
          assert.ok(hasPlugin(current.sharedInventory.installedPlugins, slugB))
          assert.ok(!hasPlugin(current.sharedInventory.installedPlugins, slugA))
          assert.ok(hasPlugin(current.composerApps, slugB))
          assert.ok(!hasPlugin(current.composerApps, slugA))
          stability.push({ elapsedMs: Date.now() - stabilityStartedAt, ...summarize(current) })
          return stability.at(-1)
        },
        sample => sample.elapsedMs >= 500,
        'Current account inventory did not remain stable after the old response completed'
      )
      const afterRelease = await assertViews(slugB, true, deviceId)
      await assertViews(slugA, false, deviceId)
      const actualB = await request('/plugins/installed', { token: login.access_token })
      assert.ok(actualB.items.some(item => item.spec.source.pluginKey === slugB))
      assert.ok(!actualB.items.some(item => item.spec.source.pluginKey === slugA))
      apiProxy.rule = originalRule
      await captureScreenshot(control, 'plugin-scope-account-b-after-old-response.png')
      await authorizeAccount(accountA, cloud.authToken)
      accountMayHaveChanged = false
      await refreshCatalog()
      const restoredA = await assertViews(slugA, true, deviceId)
      await assertViews(slugB, false, deviceId)
      return {
        accountA: { id: accountA.id, userName: accountA.user_name },
        accountB: { id: accountB.id, userName: accountB.user_name },
        markers,
        heldResponse: {
          requestIndex: apiProxy.requests.indexOf(pending),
          status: pending.status,
          fullyReceived: pending.committedResponseHeld,
          released: pending.released,
          rendererCompleted: consumed,
          stableInventorySamples: stability,
        },
        before,
        beforeRelease,
        afterRelease,
        restoredA,
      }
    })
  } finally {
    apiProxy.rule = originalRule
    await Promise.all(
      apiProxy.requests
        .filter(entry => entry.committedResponseHeld && !entry.released)
        .map(entry => entry.release())
    )
    try {
      await closeComposerPicker()
      if (inDeviceB) await restoreDeviceA()
      if (accountMayHaveChanged && accountA) {
        await authorizeAccount(accountA, cloud.authToken)
        accountMayHaveChanged = false
      }
      await backToCatalog()
    } catch (error) {
      report.cleanupError = String(error.message ?? error)
      failures.push(error)
    }
    report.passed =
      failures.length === 0 &&
      report.cases.length === 2 &&
      report.cases.every(result => result.passed)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }
  if (failures.length)
    throw new AggregateError(failures, 'Real plugin scope boundary checks failed')
  return report
}
