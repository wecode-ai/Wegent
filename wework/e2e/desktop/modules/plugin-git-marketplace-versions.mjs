import { createServer } from 'node:http'
import { once } from 'node:events'
import { dirname } from 'node:path'

import { waitForSnapshot } from './conversation-layout.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { configuredMarketplaceSource } from './marketplace-config-evidence.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import {
  access,
  assert,
  commandOutput,
  CONNECTOR_AUTH_MARKER_NAME,
  createPluginMarketplaceFixture,
  DEFAULT_STEP_TIMEOUT_MS,
  join,
  mkdir,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_NAME,
  readFile,
  rename,
  rm,
  withTimeout,
  writeFile,
} from './shared.mjs'

const marketplaceName = 'desktop-e2e-git-market'
const otherMarketplace = 'desktop-e2e-same-name-market'
const originalVersion = '0.1'
const publishedVersion = '0.2'
const qrConnector = 'marketplace-qr'

function controlId(id) {
  return '[data-testid="' + id + '"]'
}

async function writeRelease(root, version) {
  const manifestPath = join(root, 'plugins', PLUGIN_NAME, '.codex-plugin', 'plugin.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version }))
  commandOutput('git', ['add', '.'], { cwd: root })
  commandOutput(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=' + join(root, 'disabled-fixture-hooks'),
      'commit',
      '-qm',
      version,
    ],
    { cwd: root }
  )
  commandOutput('git', ['update-server-info'], { cwd: root })
}

async function startGitFixture(root) {
  await createPluginMarketplaceFixture(root)
  const catalogPath = join(root, '.agents', 'plugins', 'marketplace.json')
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  await writeFile(catalogPath, JSON.stringify({ ...catalog, name: marketplaceName }))
  commandOutput('git', ['init', '--object-format=sha1', '-qb', 'main'], { cwd: root })
  await writeRelease(root, originalVersion)

  let failedFetch
  // Serve the fixture's real Git objects over the dumb HTTP protocol.
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    const gitPath = path.replace(/^\/catalog\.git\//, '')
    if (gitPath === 'info/refs' && failedFetch) {
      const { started, response: gate } = failedFetch
      started.resolve()
      await gate.promise
      response.writeHead(404).end()
      return
    }
    if (
      !/^(HEAD|info\/refs|objects\/info\/packs|objects\/[a-f0-9]{2}\/[a-f0-9]{38}|objects\/pack\/pack-[a-f0-9]{40}\.(pack|idx))$/.test(
        gitPath
      )
    ) {
      response.writeHead(404).end()
      return
    }
    try {
      const bytes = await readFile(join(root, '.git', gitPath))
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(bytes)
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/catalog.git',
    holdFailedFetch() {
      const started = Promise.withResolvers()
      const response = Promise.withResolvers()
      failedFetch = { started, response }
      return {
        started: started.promise,
        respond: response.resolve,
        dispose() {
          failedFetch = undefined
          response.resolve()
        },
      }
    },
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function holdConnectorCommand(pluginRoot, executorHome, action) {
  const started = marketplaceName + '-' + action + '-started'
  const released = marketplaceName + '-' + action + '-released'
  const windows = process.platform === 'win32'
  const script = join(pluginRoot, 'scripts', windows ? 'local-auth.ps1' : 'local-auth.sh')
  const source = await readFile(script, 'utf8')
  const branch = windows ? `  '${action}' {` : `  ${action})`
  const gate = windows
    ? [
        `    New-Item -ItemType File -Force "$env:WEGENT_EXECUTOR_HOME/${started}" | Out-Null`,
        `    while (-not (Test-Path -LiteralPath "$env:WEGENT_EXECUTOR_HOME/${released}")) { Start-Sleep -Milliseconds 100 }`,
      ]
    : [
        `    touch "$WEGENT_EXECUTOR_HOME/${started}"`,
        `    while [ ! -f "$WEGENT_EXECUTOR_HOME/${released}" ]; do sleep 0.1; done`,
      ]
  assert.ok(source.includes(branch), `The installed connector has no ${action} command`)
  await writeFile(script, source.replace(branch, [branch, ...gate].join('\n')))
  return {
    waitForStart: () =>
      waitForValue(
        () =>
          access(join(executorHome, started)).then(
            () => true,
            () => false
          ),
        Boolean,
        `The connector did not start ${action}`,
        DEFAULT_STEP_TIMEOUT_MS
      ),
    release: () => writeFile(join(executorHome, released), ''),
  }
}

async function addInstallCandidate(root, name) {
  const manifest = join(root, '.agents/plugins/marketplace.json')
  const plugin = join(root, 'plugins', name, '.codex-plugin')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }))
  const catalog = JSON.parse(await readFile(manifest, 'utf8'))
  catalog.plugins.push({ name, source: { source: 'local', path: './plugins/' + name } })
  await writeFile(manifest, JSON.stringify(catalog))
  return manifest
}

export async function verifyGitMarketplaceVersions({ codexHome, control, executorHome, root }) {
  const fixture = await startGitFixture(root)
  const request = (method, params) =>
    requestExecutor(
      control,
      'codex.app_server_request',
      { method, params },
      DEFAULT_STEP_TIMEOUT_MS
    )
  const installedId = PLUGIN_NAME + '@' + marketplaceName
  try {
    const registered = await request('marketplace/add', { source: fixture.url, refName: 'main' })
    assert.equal(registered.marketplaceName, marketplaceName)
    await request('plugin/install', {
      marketplacePath: join(registered.installedRoot, '.agents', 'plugins', 'marketplace.json'),
      pluginName: PLUGIN_NAME,
    })
    const installedManifest = join(
      codexHome,
      'plugins',
      'cache',
      marketplaceName,
      PLUGIN_NAME,
      originalVersion,
      '.codex-plugin',
      'plugin.json'
    )
    const activatedManifest = join(
      registered.installedRoot,
      'plugins',
      PLUGIN_NAME,
      '.codex-plugin',
      'plugin.json'
    )
    const packageBefore = await readFile(installedManifest, 'utf8')
    assert.equal(JSON.parse(packageBefore).version, originalVersion)
    const installedRoot = dirname(dirname(installedManifest))
    const auth = (method, params) =>
      requestExecutor(
        control,
        'runtime.local_connector_auth.' + method,
        {
          pluginKey: PLUGIN_NAME,
          connectorSlug: CONNECTOR_AUTH_MARKER_NAME,
          marketplaceId: marketplaceName,
          ...params,
        },
        DEFAULT_STEP_TIMEOUT_MS
      )
    const session = await auth('start')
    assert.ok(session.sessionId, 'The installed package must start local authentication')
    await waitForValue(
      () => auth('poll', { sessionId: session.sessionId }),
      result => result.status === 'ok',
      'Git marketplace fixture did not authorize its connector',
      DEFAULT_STEP_TIMEOUT_MS
    )
    const authMarker = join(executorHome, CONNECTOR_AUTH_MARKER_NAME)
    await access(authMarker)

    const activeBefore = await readFile(activatedManifest, 'utf8')
    assert.equal(JSON.parse(activeBefore).version, originalVersion)
    // Publish to Git without changing the active catalog, which Codex can sync into the cache.
    await writeRelease(root, publishedVersion)

    await control.command('click', controlId('plugins-button'))
    await control.command('click', controlId('plugins-manage-button'))
    await control.command('click', controlId('plugin-management-surface-marketplaces'))
    const check = controlId('plugin-marketplace-management-check-' + marketplaceName)
    await control.command('waitFor', check, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
    commandOutput('git', ['branch', 'alternate'], { cwd: root })
    commandOutput('git', ['update-server-info'], { cwd: root })
    const changeRef = value =>
      request('config/value/write', {
        keyPath: 'marketplaces.' + marketplaceName + '.ref',
        value,
        mergeStrategy: 'replace',
        reloadUserConfig: true,
      })
    const marketRow = controlId('plugin-marketplace-management-row-' + marketplaceName)
    const installedRow = controlId('installed-plugin-row-' + installedId)
    const waitForSourceChanged = () =>
      control.command(
        'waitFor',
        controlId('plugin-operation-notice') + '[data-notice-kind="error"]',
        {
          text: 'The marketplace source changed',
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
    await changeRef('alternate')
    await control.command('clickWhenEnabled', check, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
    await waitForSourceChanged()
    await control.command('waitFor', marketRow, {
      text: 'alternate',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('click', controlId('plugin-management-surface-wework'))
    await control.command('waitFor', installedRow, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
    await waitForSnapshot(
      control,
      snapshot => !snapshot.text.includes('市场新版 v' + publishedVersion),
      'A check for the former Git source published a version hint',
      DEFAULT_STEP_TIMEOUT_MS
    )
    await changeRef('main')
    await control.command('click', controlId('plugin-management-surface-marketplaces'))
    await control.command('waitFor', marketRow, {
      text: 'main',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('clickWhenEnabled', check, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
    await control.command(
      'waitFor',
      controlId('plugin-operation-notice') + '[data-notice-kind="success"]',
      {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await control.command('click', controlId('plugin-management-surface-wework'))
    await control.command('waitFor', installedRow, {
      text: `当前 v${originalVersion}，市场新版 v${publishedVersion}`,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    assert.equal(
      await readFile(installedManifest, 'utf8'),
      packageBefore,
      'Checking replaced the installed package'
    )
    assert.equal(
      await readFile(activatedManifest, 'utf8'),
      activeBefore,
      'Checking mutated the active marketplace'
    )

    await control.command('click', controlId('plugin-management-surface-marketplaces'))
    const failedFetch = fixture.holdFailedFetch()
    try {
      await control.command('clickWhenEnabled', check, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
      await withTimeout(
        failedFetch.started,
        DEFAULT_STEP_TIMEOUT_MS,
        'The Git check did not request the fixture refs'
      )
      await changeRef('alternate')
      failedFetch.respond()
      await waitForSourceChanged()
      await control.command('waitFor', marketRow, {
        text: 'alternate',
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
    } finally {
      failedFetch.dispose()
    }
    await control.command('click', controlId('plugin-management-surface-wework'))
    await control.command('waitFor', installedRow, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
    await waitForSnapshot(
      control,
      snapshot => !snapshot.text.includes('市场新版 v' + publishedVersion),
      'A failed check retained a version hint for the former Git source',
      DEFAULT_STEP_TIMEOUT_MS
    )
    await changeRef('main')

    const otherRoot = join(dirname(root), otherMarketplace)
    await createPluginMarketplaceFixture(otherRoot)
    const otherCatalog = join(otherRoot, '.agents', 'plugins', 'marketplace.json')
    const other = JSON.parse(await readFile(otherCatalog, 'utf8'))
    await writeFile(otherCatalog, JSON.stringify({ ...other, name: otherMarketplace }))
    await request('marketplace/add', { source: otherRoot })
    const otherId = PLUGIN_NAME + '@' + otherMarketplace
    const otherManifest = join(otherRoot, 'plugins', PLUGIN_NAME, '.codex-plugin/plugin.json')
    const otherVersion = '0.0.1'
    const otherPlugin = JSON.parse(await readFile(otherManifest, 'utf8'))
    await writeFile(otherManifest, JSON.stringify({ ...otherPlugin, version: otherVersion }))
    const otherMarker = otherMarketplace + '-auth'
    for (const scriptName of ['local-auth.sh', 'local-auth.ps1']) {
      const script = join(otherRoot, 'plugins', PLUGIN_NAME, 'scripts', scriptName)
      await writeFile(
        script,
        (await readFile(script, 'utf8')).replaceAll(CONNECTOR_AUTH_MARKER_NAME, otherMarker)
      )
    }
    await request('plugin/install', { marketplacePath: otherCatalog, pluginName: PLUGIN_NAME })
    const otherPackage = join(
      codexHome,
      'plugins/cache',
      otherMarketplace,
      PLUGIN_NAME,
      otherVersion,
      '.codex-plugin/plugin.json'
    )
    await access(otherPackage)

    const openRemoval = async installedMarket => {
      const activeCatalog = join(installedMarket.installedRoot, '.agents/plugins/marketplace.json')
      const active = JSON.parse(await readFile(activeCatalog, 'utf8'))
      await writeFile(activeCatalog, JSON.stringify({ ...active, plugins: [] }))
      await control.command('click', controlId('plugin-management-surface-marketplaces'))
      await control.command(
        'clickWhenEnabled',
        controlId('plugin-marketplace-management-menu-' + marketplaceName),
        { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
      await control.command(
        'click',
        controlId('plugin-marketplace-management-remove-' + marketplaceName)
      )
      await control.command('waitFor', controlId('plugin-marketplace-management-remove-dialog'), {
        text: PLUGIN_DISPLAY_NAME,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
    }
    const confirm = () =>
      control.command('clickWhenEnabled', controlId('plugin-marketplace-management-remove-confirm'))
    const otherCache = join(codexHome, 'plugins/cache', otherMarketplace)
    const parkedCache = otherCache + '.parked'
    await rename(otherCache, parkedCache)
    try {
      await writeFile(otherCache, 'This marketplace cache is unavailable')
      await openRemoval(registered)
      await control.command(
        'waitFor',
        controlId('plugin-marketplace-management-row-' + otherMarketplace),
        { text: '安装清单无法读取', timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
    } finally {
      await rm(otherCache, { force: true })
      await rename(parkedCache, otherCache)
    }
    const replacement = join(dirname(root), 'git-marketplace-replacement')
    await mkdir(join(replacement, '.agents/plugins'), { recursive: true })
    await writeFile(
      join(replacement, '.agents/plugins/marketplace.json'),
      JSON.stringify({ name: marketplaceName, plugins: [] })
    )
    await request('marketplace/remove', { marketplaceName })
    await request('marketplace/add', { source: replacement })
    await confirm()
    await control.command(
      'waitFor',
      controlId('plugin-management-marketplaces-panel') + ' [role="alert"]',
      {
        text: 'The marketplace source changed',
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    const replaced = (await request('config/read', {})).config
    assert.equal(replaced.marketplaces[marketplaceName].source_type, 'local')
    assert.ok(replaced.plugins[installedId])
    await access(installedManifest)
    await access(authMarker)

    await request('marketplace/remove', { marketplaceName })
    const restored = await request('marketplace/add', { source: fixture.url, refName: 'main' })
    await control.command('click', controlId('plugin-management-surface-wework'))
    await openRemoval(restored)
    const installedPlugin = JSON.parse(await readFile(installedManifest, 'utf8'))
    installedPlugin.connectors.push({
      slug: qrConnector,
      localAuth: {
        kind: 'local_qr',
        start: ['scripts/local-auth.sh', 'health'],
        poll: ['scripts/local-auth.sh', 'login'],
        health: ['scripts/local-auth.sh', 'health'],
      },
    })
    await writeFile(installedManifest, JSON.stringify(installedPlugin))
    const login = await holdConnectorCommand(installedRoot, executorHome, 'login')
    const polling = auth('poll', { connectorSlug: qrConnector }).then(
      result => ({ result }),
      error => ({ error })
    )
    try {
      await login.waitForStart()
      await confirm()
      await waitForValue(
        async () => {
          try {
            await auth('start', { connectorSlug: qrConnector })
            return false
          } catch (error) {
            if (!String(error).includes('The plugin marketplace is being removed')) throw error
            return true
          }
        },
        Boolean,
        'Marketplace removal did not stop admitting QR requests',
        DEFAULT_STEP_TIMEOUT_MS
      )
      await changeRef('alternate')
    } finally {
      await login.release()
    }
    const pollOutcome = await polling
    if (pollOutcome.error) throw pollOutcome.error
    assert.equal(pollOutcome.result.status, 'ok')
    await control.command(
      'waitFor',
      controlId('plugin-management-marketplaces-panel') + ' [role="alert"]',
      {
        text: 'The marketplace source changed',
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await access(installedManifest)
    await access(authMarker)
    await changeRef('main')
    await control.command('click', controlId('plugin-management-surface-wework'))
    await openRemoval(restored)
    const candidate = 'marketplace-cleanup-candidate'
    const otherCandidateId = candidate + '@' + otherMarketplace
    const removingManifest = await addInstallCandidate(restored.installedRoot, candidate)
    const otherCandidateManifest = await addInstallCandidate(otherRoot, candidate)
    const logout = await holdConnectorCommand(installedRoot, executorHome, 'logout')
    try {
      await confirm()
      await logout.waitForStart()
      await assert.rejects(auth('start'), /The plugin marketplace is being removed/)
      await assert.rejects(
        auth('poll', { connectorSlug: qrConnector }),
        /The plugin marketplace is being removed/
      )
      await assert.rejects(
        request('plugin/install', { marketplacePath: removingManifest, pluginName: candidate }),
        /The plugin marketplace is being removed/
      )
      await assert.rejects(changeRef('alternate'), /The plugin marketplace is being removed/)
      await request('plugin/install', {
        marketplacePath: otherCandidateManifest,
        pluginName: candidate,
      })
      await request('config/value/write', {
        keyPath: 'plugins',
        value: { [otherCandidateId]: { enabled: false } },
        mergeStrategy: 'upsert',
        reloadUserConfig: true,
      })
      const peer = await auth('start', { marketplaceId: otherMarketplace })
      await waitForValue(
        () => auth('poll', { marketplaceId: otherMarketplace, sessionId: peer.sessionId }),
        result => result.status === 'ok',
        'The same-name plugin in the other marketplace did not authorize',
        DEFAULT_STEP_TIMEOUT_MS
      )
      await access(join(executorHome, otherMarker))
    } finally {
      await logout.release()
    }
    await waitForSnapshot(
      control,
      snapshot =>
        !snapshot.testIds.includes('plugin-marketplace-management-row-' + marketplaceName) &&
        !snapshot.testIds.includes('plugin-marketplace-management-remove-dialog'),
      'The confirmed marketplace remained visible after removal',
      DEFAULT_STEP_TIMEOUT_MS
    )
    const config = await readFile(join(codexHome, 'config.toml'), 'utf8')
    assert.equal(configuredMarketplaceSource(config, marketplaceName), null)
    const nativeConfig = (await request('config/read', { includeLayers: false })).config
    assert.equal(nativeConfig.plugins[installedId], undefined)
    assert.equal(
      nativeConfig.plugins[otherCandidateId]?.enabled,
      false,
      'The other marketplace install and config merge were not applied'
    )
    assert.ok(
      nativeConfig.plugins[otherId],
      'The same plugin in another marketplace must remain installed'
    )
    await assert.rejects(access(installedRoot), { code: 'ENOENT' })
    await assert.rejects(access(authMarker), { code: 'ENOENT' })
    await access(otherPackage)
    await request('plugin/uninstall', { pluginId: otherCandidateId })
    await request('plugin/uninstall', { pluginId: otherId })
    await request('marketplace/remove', { marketplaceName: otherMarketplace })
  } finally {
    await fixture.close()
  }
}
