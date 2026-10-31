import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'
import { requestPluginExecutor, testId, until } from './plugin-regression-fixture.mjs'
import {
  configureFirstProjectExecutionEnvironment,
  createLocalCollaborationProject,
  openProjectAgentCreator,
  selectProjectRunnerModel,
  waitForTestIdByText,
} from './workspace-flows.mjs'
import { createZipFixture } from './zip-fixtures.mjs'
import { verifyPluginDetailCacheRace } from './plugin-detail-cache-race.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PREFIX = 'cloud-project-chat-agent'
const DIALOG = `${PREFIX}-editor`
const scoped = selector => `${CONTENT} ${selector}`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" rx="8" fill="#3155aa"/><path d="M12 24h24M24 12v24" stroke="white" stroke-width="6"/></svg>\n'
)

function assertWithin(root, path) {
  const suffix = relative(root, path)
  assert.ok(
    suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`),
    'Plugin detail fault target escaped the isolated result directory'
  )
}

async function missing(path) {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
}

/** Replace only an owned package manifest and refuse to overwrite background repairs. */
async function replaceOwnedManifest(root, path, injected) {
  assertWithin(root, await realpath(path))
  const parent = await realpath(dirname(path))
  assertWithin(root, parent)
  const identity = await lstat(path)
  assert.ok(identity.isFile() && !identity.isSymbolicLink() && identity.nlink === 1)
  const original = await readFile(path)
  const backup = `${path}.detail-e2e-${process.pid}.backup`
  assert.ok(await missing(backup), 'Plugin detail backup already exists')
  await rename(path, backup)
  let injectedIdentity
  try {
    await writeFile(path, injected, { flag: 'wx', mode: identity.mode & 0o777 })
    injectedIdentity = await lstat(path)
  } catch (error) {
    if (!(await missing(path))) {
      const created = await lstat(path)
      assert.ok(created.isFile() && !created.isSymbolicLink() && created.nlink === 1)
      assert.ok((await readFile(path)).equals(injected), 'Fault setup found unexpected file bytes')
      await rm(path)
    }
    if (await missing(path)) await rename(backup, path)
    throw error
  }
  async function check() {
    assert.equal(await realpath(dirname(path)), parent, 'Plugin manifest parent changed')
    const current = await lstat(path)
    assert.ok(current.isFile() && !current.isSymbolicLink() && current.nlink === 1)
    assert.equal(current.dev, injectedIdentity.dev)
    assert.equal(current.ino, injectedIdentity.ino, 'Plugin manifest fault was replaced')
    assert.ok((await readFile(path)).equals(injected), 'Plugin manifest fault was repaired')
  }
  return {
    originalSha256: hash(original),
    injectedSha256: hash(injected),
    check,
    async restore() {
      await check()
      const saved = await lstat(backup)
      assert.ok(saved.isFile() && !saved.isSymbolicLink() && saved.nlink === 1)
      assert.equal(saved.dev, identity.dev)
      assert.equal(saved.ino, identity.ino, 'Plugin manifest backup changed')
      assert.ok((await readFile(backup)).equals(original), 'Plugin manifest backup bytes changed')
      await rm(path)
      await rename(backup, path)
      assert.ok((await readFile(path)).equals(original), 'Plugin manifest restoration failed')
    },
  }
}

/** Exercise single-package detail and image failures through real local services and UI. */
export async function verifyPluginDetailResilience({
  control,
  resultDir,
  executorHome,
  captureScreenshot,
  workbenchReadyTimeoutMs,
}) {
  const reportPath = join(resultDir, 'plugin-detail-resilience-evidence.json')
  const report = {
    scope: 'Real personal plugin manifest/detail failure and missing relative logo isolation',
    excluded: ['Remote plugin detail failures', 'Image download network failures'],
    preconditions: { completed: false },
    phases: [],
    faultChecks: [],
    localCatalogRefreshes: [],
    detailReads: [],
    blocked: [],
    imageFailures: [],
  }
  const failures = []
  const startedAt = Date.now()
  const root = await realpath(resultDir)
  assertWithin(root, await realpath(executorHome))
  const fixtures = []
  let activeFault
  let projectId
  let marketplacePath
  let marketplaceManifestPath
  const appLogPath = join(resultDir, 'app.log')
  let imageEvidenceLogStart = 0

  async function requestExecutor(method, params = {}) {
    const { status, payload } = await requestPluginExecutor(control, method, params)
    return { status, ...payload }
  }

  async function detail(item, successful = true) {
    const response = await requestExecutor('codex.app_server_request', {
      method: 'plugin/read',
      params: {
        marketplacePath: marketplaceManifestPath,
        remoteMarketplaceName: null,
        pluginName: item.name,
      },
    })
    const knownMessages = [
      [/Is a directory/i, 'Marketplace path is a directory'],
      [/not found|No such file|does not exist/i, 'Requested local plugin file is missing'],
      [
        /invalid.*(?:json|manifest)|expected.*(?:line|column)|failed to parse/i,
        'Local plugin manifest is invalid',
      ],
      [/authenticat|login required/i, 'Plugin detail requires authentication'],
    ]
    const errorCode = response.error?.code
    const observation = {
      plugin: item.name,
      expectedSuccess: successful,
      actualSuccess: response.ok === true,
      status: response.status,
      errorCode:
        typeof errorCode === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(errorCode)
          ? errorCode
          : null,
      errorMessage:
        response.ok === true
          ? null
          : (knownMessages.find(([pattern]) =>
              pattern.test(String(response.error?.message ?? ''))
            )?.[1] ?? 'Unclassified detail failure; inspect the isolated Executor log'),
    }
    report.detailReads.push(observation)
    assert.equal(
      response.ok,
      successful,
      `${item.name} real detail returned the wrong outcome: ${JSON.stringify(observation)}`
    )
    if (successful) {
      assert.equal(response.status, 200)
      const plugin = response.result?.plugin
      assert.equal(plugin?.summary?.name, item.name)
      assert.ok(Array.isArray(plugin.skills), 'Real plugin detail did not return skills')
      observation.skills = plugin.skills.map(skill => ({
        name: typeof skill.name === 'string' ? skill.name : null,
        enabled: skill.enabled === true,
        path: null,
      }))
      const expectedSkillPath = await realpath(
        join(item.pluginPath, 'skills', item.skill, 'SKILL.md')
      )
      assertWithin(root, expectedSkillPath)
      for (let index = 0; index < plugin.skills.length; index += 1) {
        const component = plugin.skills[index]
        assert.equal(typeof component.path, 'string', 'Real skill detail omitted its package path')
        const componentPath = await realpath(component.path)
        assertWithin(root, componentPath)
        observation.skills[index].path = relative(root, componentPath)
      }
      const expected = plugin.skills.find(skill => skill.name === item.qualifiedSkill)
      assert.ok(
        expected,
        `Real plugin detail omitted ${item.qualifiedSkill}: ${JSON.stringify(observation.skills)}`
      )
      assert.equal(await realpath(expected.path), expectedSkillPath)
      assert.equal(expected.enabled, true, 'Fixture skill is not enabled in the real Codex detail')
      const skillBytes = await readFile(expectedSkillPath)
      assert.ok(skillBytes.equals(item.skillBytes), 'Real detail points at unexpected skill bytes')
      observation.expectedSkillFileVerified = true
      observation.skillSha256 = hash(skillBytes)
      return plugin
    }
    assert.ok(response.status >= 400, 'Real detail failure did not reject the RPC')
    assert.ok(response.error?.message, 'Real detail failure has no error message')
    return { status: response.status, errorCode: response.error.code }
  }

  async function refreshLocalCodexCatalog(label) {
    const response = await requestExecutor('codex.app_server_request', {
      method: 'plugin/list',
      params: { cwds: null, marketplaceKinds: ['local'], forceRefetch: true },
    })
    assert.equal(response.status, 200, 'Real local Codex catalog refresh failed')
    assert.equal(response.ok, true, 'Real local Codex catalog refresh was rejected')
    assert.ok(Array.isArray(response.result?.marketplaces))
    assert.ok(
      response.result.marketplaces.some(marketplace => marketplace.name === 'wework-personal')
    )
    report.localCatalogRefreshes.push({ label, acknowledged: true })
  }

  async function backToList() {
    await control.command('click', testId('workspace-tab-select-fixed-task'))
    if (Number(await control.command('getElementCount', testId('plugin-detail-back-button')))) {
      await control.command('click', testId('plugin-detail-back-button'))
    }
    await control.command('click', testId('plugins-button'))
    await control.command('waitFor', testId('plugins-search-input'))
    await control.command('click', testId('plugins-distribution-tab-personal'))
    await control.command('fill', testId('plugins-search-input'), { value: 'detail-resilience-' })
  }

  async function rowFor(item) {
    return until(
      async () => {
        const snapshot = JSON.parse(
          await control.command('snapshot', testId('plugins-page-content'))
        )
        return snapshot.testIds.filter(
          id => id.startsWith('plugin-marketplace-row-') && id.includes(item.name)
        )
      },
      values => values.length === 1,
      `A unique real catalog row for ${item.name} was not available`
    ).then(values => testId(values[0]))
  }

  async function openDetail(item) {
    await backToList()
    const row = await rowFor(item)
    await control.command('click', row)
    await control.command('waitFor', testId('plugin-detail-back-button'))
    const heading = await control.command(
      'getText',
      'header:has([data-testid="plugin-detail-logo"])'
    )
    assert.ok(heading.includes(item.displayName) || heading.includes(item.name))
  }

  async function healthyDetail(item, entry) {
    await detail(item)
    await openDetail(item)
    await control.command('waitFor', testId(`plugin-skill-open-${item.qualifiedSkill}`))
    assert.equal(
      Number(await control.command('getElementCount', testId('plugin-detail-action-error'))),
      0,
      'A different plugin inherited the failed detail error'
    )
    assert.ok((await readFile(join(item.pluginPath, 'assets/logo.svg'))).equals(SVG))
    entry.healthyDetailReadable = true
    entry.healthyLogoBytesVerified = true
    await backToList()
    await rowFor(item)
    entry.healthyCatalogRowPresent = true
    await control.command('click', testId('plugins-manage-button'))
    await control.command('waitFor', testId(`installed-plugin-row-${item.id}`))
    await control.command('waitFor', testId(`installed-plugin-toggle-${item.id}`), {
      enabled: true,
    })
    entry.healthyManagementRowActionable = true
  }

  async function refreshUiLogoCatalog(label, entry) {
    await backToList()
    await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
    await control.command('waitFor', testId('plugins-refresh-button'), {
      enabled: true,
      stableMs: 250,
    })
    entry.uiCatalogRefresh = { label, completed: true }
  }

  async function imageRequests(path) {
    return JSON.parse(
      await control.command('getPluginImageRequestTimings', 'body', { value: path })
    )
  }

  async function expectImageRequest(path, startedAfter, responseStatus, entry, field) {
    return until(
      async () => {
        const observed = await imageRequests(path)
        const requests = observed.filter(
          request => request.initiatorType === 'img' && request.startedAt >= startedAfter
        )
        // Keep the full real timeline so reuse and clock/window errors are distinguishable.
        entry[`${field}Timeline`] = { startedAfter, observedAt: Date.now(), requests: observed }
        entry[field] = requests
        return requests
      },
      requests => requests.some(request => request.responseStatus === responseStatus),
      `The renderer did not attempt the exact plugin image with HTTP ${responseStatus}`
    )
  }

  async function healthyLogo(item, entry, restored = false) {
    await openDetail(item)
    await control.command('waitFor', testId(`plugin-skill-open-${item.qualifiedSkill}`))
    const selector = `${testId('plugin-detail-logo')} img`
    const load = await until(
      async () => {
        const images = JSON.parse(await control.command('getImageLoadState', selector))
        entry.lastImageLoadState = { plugin: item.name, images }
        return images
      },
      images =>
        images.length === 1 &&
        images[0].complete &&
        images[0].naturalWidth > 0 &&
        images[0].naturalHeight > 0,
      `The real logo for ${item.name} did not decode successfully`
    )
    const source = await control.command('getAttribute', selector, {
      value: 'src',
    })
    assert.ok(
      decodeURIComponent(source).includes(item.name),
      'Healthy logo points at another plugin'
    )
    const imageUrl = new URL(source, await control.command('getLocationOrigin', 'body'))
    assert.equal(imageUrl.pathname, '/wework/executor/v1/plugin-image')
    const imagePath = imageUrl.searchParams.get('path')
    assert.equal(typeof imagePath, 'string')
    assert.equal(
      await realpath(imagePath),
      await realpath(join(item.pluginPath, 'assets/logo.svg')),
      'The displayed image request does not address the verified original package image'
    )
    item.renderedLogoPath = imagePath
    if (restored) {
      // Restoring identical bytes restores the original URL. Chromium may reuse
      // its decoded image without emitting another ResourceTiming entry.
      entry.restoredImageRequests = await imageRequests(imagePath)
      assert.ok(
        entry.restoredImageRequests.some(
          request => request.initiatorType === 'img' && request.responseStatus === 200
        ),
        'The restored original image has no successful real request'
      )
    }
    assert.ok((await readFile(join(item.pluginPath, 'assets/logo.svg'))).equals(SVG))
    const path = await realpath(join(item.pluginPath, 'assets/logo.svg'))
    assertWithin(root, path)
    entry.healthyLogos ??= []
    entry.healthyLogos.push({
      plugin: item.name,
      imagePresent: true,
      decoded: load[0],
      path: relative(root, path),
      fileSha256: hash(SVG),
    })
  }

  async function captureImageFailures() {
    const bytes = await readFile(appLogPath)
    assert.ok(
      bytes.length >= imageEvidenceLogStart,
      'The isolated image evidence log was truncated'
    )
    const evidence = new Map()
    for (const line of bytes.subarray(imageEvidenceLogStart).toString('utf8').split(/\r?\n/)) {
      if (!line.includes('Not allowed to load local resource: file://')) continue
      const item = fixtures.find(fixture => line.includes(`/plugins/${fixture.name}/`))
      if (!item) continue
      const url = line.match(/file:\/\/[^\s'"<>]+/)?.[0]
      if (!url) continue
      const path = fileURLToPath(url)
      const suffix = relative(root, path)
      const owned =
        suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
      const key = `${item.name}:${owned ? suffix : 'outside-isolated-root'}`
      const current = evidence.get(key) ?? {
        plugin: item.name,
        code: 'LOCAL_FILE_RESOURCE_DENIED',
        path: owned ? suffix : null,
        occurrences: 0,
      }
      current.occurrences += 1
      evidence.set(key, current)
    }
    report.imageFailures = [...evidence.values()]
  }

  async function closeForm() {
    if (Number(await control.command('getElementCount', testId(DIALOG), { visible: true }))) {
      await control.command('click', testId(`${PREFIX}-cancel`))
      await control.command('waitFor', testId(DIALOG), { visible: false })
    }
  }

  async function configureHealthyAgent(item, entry) {
    const name = `Detail isolation ${entry.name} ${process.pid}`
    await control.command('click', testId('workspace-tab-select-fixed-board'))
    await control.command('click', scoped(testId('collaboration-tab-manage')))
    await control.command('click', scoped(testId('collaboration-project-settings-agents')))
    await openProjectAgentCreator(control, scoped(testId('project-agent-add')), 10_000)
    await control.command('fill', testId(`${PREFIX}-display-name`), { value: name })
    await selectProjectRunnerModel(control, 10_000)
    await control.command('click', testId(`${DIALOG}-advanced-toggle`))
    await control.command('click', testId(`${PREFIX}-capability-mode-manual`))
    await control.command('clickWhenEnabled', testId(`${PREFIX}-plugins-add`))
    const candidate = testId(`${PREFIX}-plugin-${item.id}`)
    await control.command('waitFor', candidate, { enabled: true })
    await control.command('click', candidate)
    await control.command('waitFor', testId(`${PREFIX}-plugins-picker`), { visible: false })
    await control.command('clickWhenEnabled', testId(`${PREFIX}-save`))
    await control.command('waitFor', testId(DIALOG), { visible: false })
    const rowId = await waitForTestIdByText(
      control,
      scoped(testId('project-agent-list')),
      'project-agent-row-',
      name,
      10_000
    )
    const response = await requestExecutor('chat_agents.list', { project_id: projectId })
    assert.equal(response.ok, true)
    const agent = response.result.find(
      value => value.id === rowId.slice('project-agent-row-'.length)
    )
    assert.ok(agent, 'Saved Agent is missing from the real local database')
    assert.equal(agent.capability_mode, 'manual')
    assert.ok(agent.plugins.some(plugin => plugin.id === item.id))
    entry.healthyAgentBindingPersisted = true
    await closeForm()
  }

  async function phase(name, run) {
    const entry = { name, passed: false }
    const started = Date.now()
    report.phases.push(entry)
    try {
      await run(entry)
      entry.passed = true
    } catch (error) {
      entry.error = String(error?.message ?? error)
      failures.push(new Error(`${name}: ${entry.error}`, { cause: error }))
    } finally {
      entry.elapsedMs = Date.now() - started
      try {
        entry.screenshot = `plugin-detail-resilience-${name}.png`
        await captureScreenshot(control, entry.screenshot, 'body')
      } catch (error) {
        entry.passed = false
        entry.captureError = String(error?.message ?? error)
        failures.push(new Error(`${name}: screenshot failed`, { cause: error }))
      }
      await closeForm().catch(error => {
        entry.passed = false
        failures.push(new Error(`${name}: form cleanup failed`, { cause: error }))
      })
    }
    return entry
  }

  async function checkFault(label, broken, healthy, kind) {
    await activeFault.check()
    const result = await detail(broken, kind !== 'manifest')
    if (kind === 'logo') {
      assert.ok(await missing(broken.missingLogoPath), 'The real missing logo appeared')
      assert.ok(result.summary.interface?.logo?.includes(broken.missingLogoName))
    }
    await detail(healthy)
    report.faultChecks.push({
      label,
      kind,
      manifestMatchesInjection: true,
      healthyDetailReadable: true,
    })
  }

  async function importFixture(suffix) {
    const name = `detail-resilience-${suffix}`
    const item = {
      name,
      id: `${name}@wework-personal`,
      displayName: name,
      skill: `detail-${suffix}`,
    }
    item.qualifiedSkill = `${name}:${item.skill}`
    item.skillBytes = Buffer.from(
      `---\nname: ${item.skill}\ndescription: Real ${suffix} detail isolation skill\n---\n\n` +
        `Use ${item.skill} to verify real package details.\n`
    )
    const fixtureRoot = join(resultDir, 'plugin-detail-resilience-fixtures')
    await mkdir(fixtureRoot, { recursive: true })
    const archivePath = join(fixtureRoot, `${name}.zip`)
    const manifest = {
      name,
      version: '1.0.0',
      description: `Real ${suffix} plugin detail isolation fixture`,
      author: { name: 'Wework Desktop E2E' },
      skills: './skills/',
      interface: {
        displayName: item.displayName,
        shortDescription: `Real ${suffix} plugin`,
        longDescription: 'Tests independent plugin details and relative package images.',
        developerName: 'Wework Desktop E2E',
        category: 'Developer Tools',
        capabilities: ['Skills'],
        defaultPrompt: 'Verify independent plugin details.',
        logo: './assets/logo.svg',
      },
    }
    await createZipFixture(archivePath, {
      '.codex-plugin/plugin.json': JSON.stringify(manifest),
      [`skills/${item.skill}/SKILL.md`]: item.skillBytes,
      'assets/logo.svg': SVG,
    })
    const preview = JSON.parse(
      await control.command('previewPluginImport', 'body', {
        value: JSON.stringify({ archivePath, marketplacePath }),
      })
    )
    assert.equal(
      preview.valid,
      true,
      `Real fixture preview failed: ${JSON.stringify(preview.issues)}`
    )
    assert.equal(preview.existing, false, 'Detail fixture already exists before import')
    assert.equal(preview.skillCount, 1, 'The package preview did not discover the fixture skill')
    const imported = JSON.parse(
      await control.command('importPluginPackage', 'body', {
        value: JSON.stringify({ preview, overwrite: false }),
      })
    )
    assert.equal(imported.pluginName, name)
    // The renderer completion intentionally omits filesystem paths. Resolve the
    // committed package from the real Executor catalog and register cleanup now.
    fixtures.push(item)
    const listed = await requestExecutor('executor.plugins.personal.list', { marketplacePath })
    assert.equal(listed.ok, true, 'The real personal catalog failed after import')
    const matching = listed.result.plugins.filter(plugin => plugin.name === name)
    assert.equal(matching.length, 1, 'Imported fixture has no unique personal catalog record')
    assert.equal(typeof matching[0].pluginPath, 'string', 'Imported fixture has no real path')
    item.pluginPath = await realpath(matching[0].pluginPath)
    assertWithin(root, item.pluginPath)
    item.manifestPath = join(item.pluginPath, '.codex-plugin/plugin.json')
    item.manifestBytes = await readFile(item.manifestPath)
    return item
  }

  try {
    imageEvidenceLogStart = (await readFile(appLogPath)).length
    const bundled = JSON.parse(await control.command('getBundledPluginUpdates', 'body'))
    marketplacePath = bundled.marketplace?.path
    assert.equal(typeof marketplacePath, 'string', 'Real personal marketplace is unavailable')
    assertWithin(root, await realpath(marketplacePath))
    marketplaceManifestPath = await realpath(
      join(marketplacePath, '.agents/plugins/marketplace.json')
    )
    assertWithin(root, marketplaceManifestPath)
    const marketplaceMetadata = await lstat(marketplaceManifestPath)
    assert.ok(
      marketplaceMetadata.isFile() && !marketplaceMetadata.isSymbolicLink(),
      'The real Codex marketplace source is not a regular manifest file'
    )
    const healthy = await importFixture('healthy')
    const broken = await importFixture('broken')
    await detail(healthy)
    await detail(broken)
    await ensureExperimentalFeaturesEnabled(control)
    await control.command('click', testId('workspace-tab-select-fixed-board'))
    const projectName = `Plugin detail isolation ${process.pid}`
    await createLocalCollaborationProject(control, CONTENT, projectName)
    const projects = await requestExecutor('projects.list')
    assert.equal(projects.ok, true)
    projectId = projects.result.find(item => item.name === projectName)?.id
    assert.ok(projectId, 'The isolated real project was not persisted')
    await configureFirstProjectExecutionEnvironment(control, CONTENT, workbenchReadyTimeoutMs)
    await backToList()
    await control.command('click', testId('plugins-refresh-button'))
    await control.command('waitFor', `${testId('plugins-refresh-button')}:not(:disabled)`)
    const baseline = await phase('healthy-before-fault', async entry => {
      await healthyDetail(healthy, entry)
      await healthyDetail(broken, entry)
      await configureHealthyAgent(healthy, entry)
    })
    assert.ok(baseline.passed, 'Real detail/UI baseline failed before fault injection')
    report.preconditions = { completed: true, healthy: healthy.name, broken: broken.name }

    activeFault = await replaceOwnedManifest(
      root,
      broken.manifestPath,
      Buffer.from('{ invalid json\n')
    )
    try {
      await refreshLocalCodexCatalog('manifest-fault-before-detail')
      await phase('single-detail-failure-isolated', async entry => {
        await checkFault('manifest-before-ui', broken, healthy, 'manifest')
        await openDetail(broken)
        await control.command('waitFor', testId('plugin-detail-action-error'))
        await control.command('waitFor', testId('plugin-detail-back-button'), { enabled: true })
        entry.detailErrorVisible = true
        entry.detailBackActionable = true
        entry.faultScreenshot = 'plugin-detail-resilience-single-detail-error.png'
        await captureScreenshot(control, entry.faultScreenshot, 'body')
        await healthyDetail(healthy, entry)
        await configureHealthyAgent(healthy, entry)
        await checkFault('manifest-after-healthy-flow', broken, healthy, 'manifest')
        await openDetail(broken)
        await control.command('waitFor', testId('plugin-detail-action-error'))
        await control.command('waitFor', testId('plugin-detail-back-button'), { enabled: true })
        entry.detailErrorRemainsDuringFault = true
      })
    } finally {
      await activeFault.restore()
      activeFault = null
    }
    await refreshLocalCodexCatalog('manifest-restored-before-catalog-refresh')
    await phase('single-detail-recovery', async entry => {
      await detail(broken)
      entry.freshRuntimeDetailReadSucceeded = true
      await backToList()
      await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
      await control.command('waitFor', testId('plugins-refresh-button'), {
        enabled: true,
        stableMs: 250,
      })
      await openDetail(broken)
      await control.command('waitFor', testId(`plugin-skill-open-${broken.qualifiedSkill}`))
      await control.command('waitFor', testId('plugin-detail-action-error'), { visible: false })
      entry.explicitCatalogRefreshRecoverySucceeded = true
      entry.recoveryPath = ['detail-back', 'plugins-refresh', 'reopen-detail']
      assert.equal(
        Number(await control.command('getElementCount', testId('plugin-detail-action-error'))),
        0
      )
      await healthyDetail(broken, entry)
      await configureHealthyAgent(healthy, entry)
      entry.originalManifestRestored = (await readFile(broken.manifestPath)).equals(
        broken.manifestBytes
      )
      assert.ok(entry.originalManifestRestored)
    })

    await phase('old-detail-preserves-new-disabled-inventory', entry =>
      verifyPluginDetailCacheRace({ control, item: broken, openDetail, backToList, entry })
    )

    const logoBaseline = await phase('healthy-logos-before-fault', async entry => {
      await healthyLogo(healthy, entry)
      await healthyLogo(broken, entry)
    })
    if (!logoBaseline.passed) {
      report.blocked.push(
        ...['single-relative-logo-failure-isolated', 'single-relative-logo-recovery'].map(name => ({
          name,
          reason: 'Strict healthy image baseline failed before logo fault injection',
          prerequisite: 'healthy-logos-before-fault',
          prerequisiteError: logoBaseline.error,
        }))
      )
    } else {
      broken.missingLogoName = `missing-detail-e2e-${process.pid}.svg`
      broken.missingLogoPath = join(broken.pluginPath, 'assets', broken.missingLogoName)
      assert.ok(await missing(broken.missingLogoPath))
      assert.equal(typeof broken.renderedLogoPath, 'string')
      const missingImageRequestPath = join(dirname(broken.renderedLogoPath), broken.missingLogoName)
      assert.equal(
        await realpath(dirname(missingImageRequestPath)),
        join(broken.pluginPath, 'assets')
      )
      // Prime the real resource timing buffer before the unique image can be requested.
      await imageRequests(missingImageRequestPath)
      await imageRequests(broken.renderedLogoPath)
      let logoFailure
      const logoFault = JSON.parse(broken.manifestBytes)
      logoFault.interface.logo = `./assets/${broken.missingLogoName}`
      activeFault = await replaceOwnedManifest(
        root,
        broken.manifestPath,
        Buffer.from(JSON.stringify(logoFault))
      )
      const logoFaultInjectedAt = Date.now()
      try {
        await refreshLocalCodexCatalog('logo-fault-before-detail')
        logoFailure = await phase('single-relative-logo-failure-isolated', async entry => {
          await checkFault('logo-before-ui', broken, healthy, 'logo')
          await refreshUiLogoCatalog('logo-fault', entry)
          await openDetail(broken)
          await control.command('waitFor', testId(`plugin-skill-open-${broken.qualifiedSkill}`))
          await expectImageRequest(
            missingImageRequestPath,
            logoFaultInjectedAt,
            404,
            entry,
            'missingImageRequests'
          )
          await control.command(
            'waitFor',
            `${testId('plugin-detail-logo')} .plugin-source-avatar-initial`
          )
          const logoClass = await control.command('getAttribute', testId('plugin-detail-logo'), {
            value: 'class',
          })
          assert.match(
            logoClass,
            /\bplugin-logo-provided\b/,
            'The fallback appeared without attempting a provided package image'
          )
          assert.equal(
            Number(await control.command('getElementCount', `${testId('plugin-detail-logo')} img`)),
            0
          )
          entry.missingLogoFallbackVisible = true
          entry.providedImageFailedBeforeFallback = true
          entry.brokenPluginDetailStillUsable = true
          entry.faultScreenshot = 'plugin-detail-resilience-single-logo-fallback.png'
          await captureScreenshot(control, entry.faultScreenshot, 'body')
          await healthyDetail(healthy, entry)
          await healthyLogo(healthy, entry)
          await configureHealthyAgent(healthy, entry)
          await checkFault('logo-after-healthy-flow', broken, healthy, 'logo')
        })
      } finally {
        await activeFault.restore()
        activeFault = null
      }
      await refreshLocalCodexCatalog('logo-restored-before-detail')
      await phase('single-relative-logo-recovery', async entry => {
        if (
          !logoFailure?.passed ||
          !logoFailure.missingLogoFallbackVisible ||
          !logoFailure.missingImageRequests?.some(request => request.responseStatus === 404)
        ) {
          entry.blocked = true
          report.blocked.push({
            name: entry.name,
            prerequisite: 'single-relative-logo-failure-isolated',
            reason: 'The exact failed image request and visible fallback were not verified',
            prerequisiteError: logoFailure?.error ?? null,
          })
          assert.fail('Image recovery cannot pass without a verified image-failure prerequisite')
        }
        await refreshUiLogoCatalog('logo-restored', entry)
        await healthyDetail(broken, entry)
        await healthyLogo(broken, entry, true)
        entry.originalManifestRestored = (await readFile(broken.manifestPath)).equals(
          broken.manifestBytes
        )
        assert.ok(entry.originalManifestRestored)
        await configureHealthyAgent(healthy, entry)
      })
    }
  } catch (error) {
    report.setupOrExecutionError = String(error?.message ?? error)
    failures.push(error)
  } finally {
    try {
      await captureImageFailures()
    } catch (error) {
      report.imageEvidenceError = String(error?.message ?? error)
      failures.push(error)
    }
    if (activeFault) {
      try {
        await activeFault.restore()
        activeFault = null
      } catch (error) {
        report.faultRestoreError = String(error?.message ?? error)
        failures.push(error)
      }
    }
    if (!activeFault) {
      for (const item of fixtures) {
        try {
          await control.command('deleteLocalPluginPackage', 'body', {
            value: JSON.stringify({ pluginId: item.id, pluginName: item.name }),
          })
          const listed = await requestExecutor('executor.plugins.personal.list', {
            marketplacePath,
          })
          assert.equal(listed.ok, true)
          assert.ok(!listed.result.plugins.some(plugin => plugin.name === item.name))
        } catch (error) {
          failures.push(new Error(`Cleanup failed for ${item.name}`, { cause: error }))
        }
      }
    }
    await backToList().catch(error => failures.push(error))
    report.faultsRestored = !activeFault
    report.elapsedMs = Date.now() - startedAt
    report.failures = failures.map(error => String(error?.message ?? error))
    report.passed =
      report.preconditions.completed &&
      report.phases.length === 7 &&
      report.blocked.length === 0 &&
      failures.length === 0
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }
  if (failures.length)
    throw new AggregateError(failures, 'Plugin detail resilience assertions failed')
  return {
    reportPath,
    screenshots: report.phases
      .flatMap(phase => [phase.faultScreenshot, phase.screenshot])
      .filter(Boolean),
  }
}
