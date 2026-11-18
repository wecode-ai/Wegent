import { mkdir, writeFile } from 'node:fs/promises'
import { waitForSnapshot } from './conversation-layout.mjs'

import { telemetryEvents } from './response-protocol.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  TELEMETRY_FORBIDDEN_PROPERTY_PATTERN,
  TELEMETRY_SAFE_PROPERTY_KEYS,
  TELEMETRY_TEST_PROJECT_KEY,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  pathExists,
  readFile,
} from './shared.mjs'

import {
  captureVerificationScreenshot,
  normalizeComposerText,
  waitForAttribute,
} from './workspace-flows.mjs'

async function verifyInitialTelemetryConsent(control, sensitiveValues) {
  const overlaySelector = '[data-testid="telemetry-consent-overlay"]'
  await control.command('waitFor', overlaySelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 750))
  assert.equal(
    control.telemetryRequestCount(),
    0,
    'Telemetry was sent before the user made an explicit consent choice'
  )

  await control.command('click', '[data-testid="telemetry-consent-accept"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('telemetry-consent-overlay'),
    'The first-run telemetry consent prompt did not close after accepting'
  )

  await control.awaitTelemetryEvent('app_started')
  const requests = control.telemetryRequests
  const events = requests.flatMap(request => telemetryEvents(request.payload))
  assert.ok(events.length > 0, 'The telemetry request did not contain an event')
  const appStarted = events.find(event => event.event === 'app_started')
  assert.ok(appStarted, 'The first telemetry request did not include app_started')
  assert.equal(appStarted.properties?.surface, 'main')

  for (const event of events) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        {
          app_started: true,
          app_startup_attempted: true,
          app_startup_failed: true,
          app_startup_succeeded: true,
          feature_opened: true,
          telemetry_preference_changed: true,
        },
        event.event
      ),
      true,
      `The initial telemetry request contained an unexpected event: ${event.event}`
    )
    assert.ok(event.properties && typeof event.properties === 'object')
    assert.ok(['mac', 'win', 'linux'].includes(event.properties.platform))
    assert.equal(event.properties.platform, event.properties.os)
    assert.equal(event.properties.event_schema_version, 1)
    assert.equal(event.properties.telemetry_source, 'wework')
    for (const propertyName of Object.keys(event.properties)) {
      assert.equal(
        TELEMETRY_SAFE_PROPERTY_KEYS.has(propertyName),
        true,
        `Telemetry sent a property outside the privacy allowlist: ${propertyName}`
      )
      if (propertyName === 'token') {
        assert.equal(
          event.properties[propertyName],
          TELEMETRY_TEST_PROJECT_KEY,
          'Telemetry sent an unexpected PostHog project key'
        )
      } else if (propertyName === '$process_person_profile') {
        assert.equal(
          event.properties[propertyName],
          false,
          'Telemetry attempted to create or update a PostHog person profile'
        )
      } else {
        assert.equal(
          TELEMETRY_FORBIDDEN_PROPERTY_PATTERN.test(propertyName),
          false,
          `Telemetry sent a potentially sensitive property: ${propertyName}`
        )
      }
    }
    assert.equal(event.$set, undefined, 'Telemetry sent person profile properties')
    assert.equal(event.$set_once, undefined, 'Telemetry sent persistent person properties')
  }

  for (const sensitiveValue of sensitiveValues.filter(Boolean)) {
    assert.equal(
      requests.some(request => request.rawBody.includes(String(sensitiveValue))),
      false,
      `Telemetry leaked a sensitive runtime value: ${String(sensitiveValue).slice(0, 24)}`
    )
  }
}

async function declineInitialTelemetryConsent(control) {
  const overlaySelector = '[data-testid="telemetry-consent-overlay"]'
  await control.command('waitFor', overlaySelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    visible: true,
  })
  await control.command('clickWhenEnabled', '[data-testid="telemetry-consent-decline"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('telemetry-consent-overlay'),
    'The first-run telemetry consent prompt did not close after declining'
  )
}

async function setExperimentalFeaturesEnabled(control, enabled) {
  const settingsButtonCount = Number(
    await control.command('getElementCount', '[data-testid="settings-button"]', {
      visible: true,
    })
  )
  if (settingsButtonCount === 0) {
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({ experimentalFeaturesEnabled: enabled }),
    })
    return
  }

  const toggleSelector = '[data-testid="general-experimental-features-toggle"]'
  await control.command('click', '[data-testid="settings-button"]', { visible: true })
  await control.command('click', '[data-testid="settings-menu-button"]')
  // The first settings visit loads the Core DSH settings module and its dependencies.
  await control.command('waitFor', '[data-testid="general-settings-page"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes('general-experimental-features-toggle'),
    'The experimental features control did not mount'
  )
  // Suspense retains hidden settings DOM while its next module is loading.
  await control.command('waitFor', '[data-testid="dsh-settings-loading"]', {
    visible: false,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('scrollIntoView', toggleSelector, { visible: true })
  await control.command('waitFor', toggleSelector, { visible: true })
  if (
    (await control.command('getAttribute', toggleSelector, { value: 'aria-checked' })) !==
    String(enabled)
  ) {
    await control.command('click', toggleSelector)
    await waitForAttribute(
      control,
      toggleSelector,
      'aria-checked',
      String(enabled),
      `${enabled ? 'Enabling' : 'Disabling'} experimental features was not persisted`
    )
  }
  await control.command('click', '[data-testid="settings-back-button"]')
}

async function ensureExperimentalFeaturesEnabled(control) {
  await setExperimentalFeaturesEnabled(control, true)
}

async function ensureExperimentalFeaturesDisabled(control) {
  await setExperimentalFeaturesEnabled(control, false)
}

async function verifySitesPluginAutoInstall(control, executorHome) {
  control.onApplicationPluginInstalled = async plugin => {
    const name = plugin.spec.source.pluginKey
    const capabilities = join(executorHome, 'capabilities')
    const relativePath = 'store/plugins/' + name + '@wegent'
    const root = join(capabilities, relativePath)
    await mkdir(join(root, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(root, '.claude-plugin/plugin.json'),
      JSON.stringify({
        name,
        version: plugin.spec.version,
        description: plugin.spec.description,
        interface: plugin.spec.interface,
      })
    )
    const manifestPath = join(capabilities, 'manifest-v2.json')
    const manifest = (await pathExists(manifestPath))
      ? JSON.parse(await readFile(manifestPath, 'utf8'))
      : { version: 2, plugins: {} }
    manifest.plugins[name + '@wegent'] = {
      name,
      marketplace: 'wegent',
      enabled: true,
      version: plugin.spec.version,
      store_path: relativePath,
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
  }
  assert.equal(
    control.sitesConnectionBootstrapRequests,
    0,
    'Connecting the cloud account unexpectedly initialized the Sites plugin'
  )

  await navigateToApplications(control)
  await control.command('waitFor', '[data-testid="site-row-prj_e2e_product"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  await control.command('clickWhenEnabled', '[data-testid="site-more-prj_e2e_product"]')
  await control.command(
    'clickWhenEnabled',
    '[data-testid="site-environment-menu-item-prj_e2e_product"]'
  )
  await control.command('waitFor', '[data-testid="environment-variables-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="environment-add-button"]')
  await control.command('fill', '[data-testid="environment-key-new-1"]', {
    value: 'E2E_API_BASE',
  })
  await control.command('fill', '[data-testid="environment-value-new-1"]', {
    value: 'https://api.example.test',
  })
  await control.command('clickWhenEnabled', '[data-testid="environment-save-button"]')
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('environment-variables-dialog') &&
      /已保存|Saved/.test(snapshot.text),
    'Saving Site environment variables did not update the environment dialog',
    DEFAULT_STEP_TIMEOUT_MS
  )
  assert.deepEqual(
    control.siteEnvironmentVariables.map(item => [item.key, item.type, item.value]),
    [['E2E_API_BASE', 'plain', 'https://api.example.test']],
    'Saving Site environment variables did not persist through the Backend fixture'
  )
  await captureVerificationScreenshot(control, 'plugins-05-site-environment.png')
  await control.command('click', '[data-testid="environment-close-button"]')

  await control.command('clickWhenEnabled', '[data-testid="site-more-prj_e2e_product"]')
  await control.command('clickWhenEnabled', '[data-testid="site-access-menu-item-prj_e2e_product"]')
  await control.command('waitFor', '[data-testid="site-access-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="site-access-audience-custom"]')
  await control.command('fill', '[data-testid="site-access-subjects"]', {
    value: 'e2e-viewer-b, e2e-viewer-a',
  })
  await control.command('clickWhenEnabled', '[data-testid="site-access-save"]')
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('site-access-dialog') &&
      /访问权限已保存|Access permissions saved/.test(snapshot.text),
    'Saving Site access did not update the access dialog',
    DEFAULT_STEP_TIMEOUT_MS
  )
  assert.deepEqual(
    control.siteAccessPolicy.subjects,
    ['e2e-viewer-a', 'e2e-viewer-b'],
    'Saving Site access did not persist through the Backend fixture'
  )
  await captureVerificationScreenshot(control, 'plugins-06-site-access.png')
  await control.command('click', '[data-testid="site-access-close"]')

  await control.command('clickWhenEnabled', '[data-testid="site-more-prj_e2e_product"]')
  await control.command(
    'clickWhenEnabled',
    '[data-testid="site-collaborators-menu-item-prj_e2e_product"]'
  )
  await control.command('waitFor', '[data-testid="site-collaborators-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="site-collaborator-subject-input"]', {
    value: 'e2e-collaborator',
  })
  await control.command('clickWhenEnabled', '[data-testid="site-collaborator-add"]')
  await control.command('waitFor', '[data-testid="site-collaborator-remove-e2e-collaborator"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.deepEqual(
    control.siteCollaborators.map(item => item.subject),
    ['e2e-collaborator'],
    'Adding a Site collaborator did not persist through the Backend fixture'
  )
  await control.command(
    'clickWhenEnabled',
    '[data-testid="site-collaborator-remove-e2e-collaborator"]'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('site-collaborators-dialog') &&
      !snapshot.testIds.includes('site-collaborator-remove-e2e-collaborator'),
    'Removing a Site collaborator did not update the collaborator dialog',
    DEFAULT_STEP_TIMEOUT_MS
  )
  assert.deepEqual(
    control.siteCollaborators,
    [],
    'Removing a Site collaborator did not persist through the Backend fixture'
  )
  await captureVerificationScreenshot(control, 'plugins-07-site-collaborators.png')
  await control.command('click', '[data-testid="site-collaborators-close"]')

  const siteInstallPath = '/api/plugins/builtin/wegent-sites/ensure-installed'
  const siteContinueCanonical =
    '[$快速建站](plugin://wegent-sites@wegent) [E2E Product Site](wegent-sites-project://prj_e2e_product) 请说出你要做的改动'
  const siteContinueVisible = '快速建站 E2E Product Site 请说出你要做的改动'
  const continueIdentity = await captureApplicationChatIdentity(control)
  const siteInstallRequestsBeforeContinue = applicationInstallRequestCount(control, siteInstallPath)
  await control.command(
    'clickWhenEnabled',
    '[data-testid="site-continue-development-prj_e2e_product"]',
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await assertFreshApplicationDraft(control, {
    before: continueIdentity,
    canonical: siteContinueCanonical,
    visible: siteContinueVisible,
    message: 'Continuing a Site did not open a fresh task with the expected draft',
  })
  assert.equal(
    applicationInstallRequestCount(control, siteInstallPath) - siteInstallRequestsBeforeContinue,
    1,
    'Continuing a Site did not install the Site plugin on demand'
  )
  await assertPluginComposerChip(control, 'wegent-sites')
  const siteLinkSelector = `${ACTIVE_COMPOSER_SELECTOR} [data-testid="composer-link-chip"]`
  assert.equal(await control.command('getText', siteLinkSelector), 'E2E Product Site')
  assert.equal(
    await control.command('getAttribute', siteLinkSelector, { value: 'data-composer-link-url' }),
    'wegent-sites-project://prj_e2e_product'
  )
  assert.equal(
    await control.command('getAttribute', siteLinkSelector, {
      value: 'data-composer-link-provider',
    }),
    'wegent-sites-project'
  )
  await assertNoSitesCreateError(control)
  await captureVerificationScreenshot(control, 'plugins-07-site-continue-fresh-task.png')

  await navigateToApplications(control)
  control.applicationPluginInspectionUnavailable = true
  const siteCreateIdentity = await captureApplicationChatIdentity(control)
  const siteInstallRequestsBeforeCreate = applicationInstallRequestCount(control, siteInstallPath)
  await control.command('clickWhenEnabled', '[data-testid="sites-create-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="sites-create-site-menu-item"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await assertFreshApplicationDraft(control, {
    before: siteCreateIdentity,
    canonical:
      '[$快速建站](plugin://wegent-sites@wegent) Build an internal website and validate it locally',
    visible: '快速建站 Build an internal website and validate it locally',
    message: 'Creating a Site did not open a fresh task with the expected plugin draft',
  })
  assert.equal(
    applicationInstallRequestCount(control, siteInstallPath) - siteInstallRequestsBeforeCreate,
    0,
    'Creating a Site should reuse the plugin installed by Continue Developing'
  )
  await assertPluginComposerChip(control, 'wegent-sites')
  await assertNoSitesCreateError(control)
  await captureVerificationScreenshot(control, 'plugins-08-site-create-fresh-task.png')

  await navigateToApplications(control, 'miniapp')
  await control.command('waitFor', '[data-testid="mini-program-row-prj_e2e_mini"]', {
    text: 'E2E Mini Program',
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const miniProgramInstallPath =
    '/api/plugins/builtin/weibo-miniapp-h5-develop-agent/ensure-installed'
  const miniProgramIdentity = await captureApplicationChatIdentity(control)
  const miniProgramInstallRequestsBefore = applicationInstallRequestCount(
    control,
    miniProgramInstallPath
  )
  await control.command('clickWhenEnabled', '[data-testid="sites-create-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="sites-create-mini-program-menu-item"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await assertFreshApplicationDraft(control, {
    before: miniProgramIdentity,
    canonical:
      '[$微博小程序H5开发助手](plugin://weibo-miniapp-h5-develop-agent@wegent) 创建并发布一个小程序',
    visible: '微博小程序H5开发助手 创建并发布一个小程序',
    message: 'Creating a Mini Program did not open a fresh task with the expected plugin draft',
  })
  assert.equal(
    applicationInstallRequestCount(control, miniProgramInstallPath) -
      miniProgramInstallRequestsBefore,
    1,
    'Creating a Mini Program did not install its application plugin on demand'
  )
  await assertPluginComposerChip(control, 'weibo-miniapp-h5-develop-agent')
  await assertNoSitesCreateError(control)
  await captureVerificationScreenshot(control, 'plugins-09-mini-program-create-fresh-task.png')

  // The real local Executor must find both installed packages on disk even
  // while Backend inventory is unavailable. No reinstall should be necessary.
  await navigateToApplications(control)
  const continueAgain = await captureApplicationChatIdentity(control)
  const installsBefore = applicationInstallRequestCount(control, siteInstallPath)
  await control.command(
    'clickWhenEnabled',
    '[data-testid="site-continue-development-prj_e2e_product"]'
  )
  await assertFreshApplicationDraft(control, {
    before: continueAgain,
    canonical: siteContinueCanonical,
    visible: siteContinueVisible,
    message: 'Installed Site could not continue while cloud inventory was unavailable',
  })
  assert.equal(applicationInstallRequestCount(control, siteInstallPath), installsBefore)
  await navigateToApplications(control, 'miniapp')
  const miniAgain = await captureApplicationChatIdentity(control)
  const miniInstallsBefore = applicationInstallRequestCount(control, miniProgramInstallPath)
  await control.command('clickWhenEnabled', '[data-testid="sites-create-button"]')
  await control.command('clickWhenEnabled', '[data-testid="sites-create-mini-program-menu-item"]')
  await assertFreshApplicationDraft(control, {
    before: miniAgain,
    canonical:
      '[$微博小程序H5开发助手](plugin://weibo-miniapp-h5-develop-agent@wegent) 创建并发布一个小程序',
    visible: '微博小程序H5开发助手 创建并发布一个小程序',
    message: 'Installed Mini Program could not open while cloud inventory was unavailable',
  })
  assert.equal(applicationInstallRequestCount(control, miniProgramInstallPath), miniInstallsBefore)
  await captureVerificationScreenshot(control, 'plugins-10-local-plugin-reuse.png')
  control.applicationPluginInspectionUnavailable = false
  control.onApplicationPluginInstalled = null
}

function applicationInstallRequestCount(control, pathname) {
  return control.httpRequests.filter(
    request => request.method === 'POST' && request.pathname === pathname
  ).length
}

function resolvedDraftInputLength(snapshot) {
  const composerLength = snapshot.workbench?.composer?.currentInputLength
  const paneLength = snapshot.pane?.inputLength
  if (composerLength === 0 && typeof paneLength === 'number' && paneLength > 0) {
    return paneLength
  }
  return composerLength ?? paneLength ?? null
}

async function captureApplicationChatIdentity(control) {
  const startedAt = Date.now()
  let candidateProjectId = null
  let candidateSince = null
  let hasCandidate = false
  let lastSnapshot = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    lastSnapshot = snapshot
    const currentProjectId = snapshot.workbench?.currentProject?.id ?? null
    if (snapshot.workbench?.isBootstrapping === false) {
      if (!hasCandidate || currentProjectId !== candidateProjectId) {
        candidateProjectId = currentProjectId
        candidateSince = Date.now()
        hasCandidate = true
      } else if (
        candidateSince !== null &&
        Date.now() - candidateSince >= COMPOSER_READY_STABILITY_MS
      ) {
        return { currentProjectId }
      }
    } else {
      candidateSince = null
      hasCandidate = false
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(
    `The application chat identity did not stabilize: ${JSON.stringify(lastSnapshot)}`
  )
}

async function assertFreshApplicationDraft(control, { before, canonical, visible, message }) {
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const startedAt = Date.now()
  let actual = ''
  let lastSnapshot = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    lastSnapshot = snapshot
    actual = normalizeComposerText(
      await control.command('getText', ACTIVE_COMPOSER_SELECTOR, { visible: true })
    )
    if (
      actual === visible &&
      resolvedDraftInputLength(snapshot) === canonical.length &&
      (snapshot.workbench?.currentRuntimeTask?.taskId ??
        snapshot.pane?.currentRuntimeTask?.taskId ??
        null) === null &&
      (snapshot.workbench?.currentProject?.id ?? null) === before.currentProjectId
    ) {
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${message}: ${JSON.stringify({ before, actual, snapshot: lastSnapshot })}`)
}

async function assertPluginComposerChip(control, pluginName) {
  const selector = `${ACTIVE_COMPOSER_SELECTOR} [data-testid="composer-plugin-chip-${pluginName}"]`
  await control.command('waitFor', selector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  assert.equal(
    await control.command('getAttribute', selector, { value: 'data-composer-plugin-name' }),
    pluginName
  )
  assert.equal(
    await control.command('getAttribute', selector, {
      value: 'data-composer-plugin-marketplace',
    }),
    'wegent'
  )
}

async function assertNoSitesCreateError(control) {
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    snapshot.testIds.includes('sites-create-error'),
    false,
    'The Applications flow reported a plugin installation error'
  )
}

async function navigateToApplications(control, tab = 'web') {
  await control.command('navigate', 'body', { value: '/sites' })
  const tabSelector =
    tab === 'miniapp'
      ? '[data-testid="applications-tab-miniapp"]'
      : '[data-testid="applications-tab-web"]'
  await control.command('waitFor', tabSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', tabSelector)
  await control.command('waitFor', '[data-testid="sites-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

function sitesMarketplacePlugin(installed) {
  return {
    id: 501,
    remotePluginId: 'wegent~Plugin_501',
    name: 'wegent-sites',
    displayName: '快速建站',
    description: 'Build and deploy websites with Wegent Sites',
    version: '0.1.0',
    author: 'Wegent Team',
    visibility: 'public',
    featured: true,
    installed,
    enabled: installed,
    installedPluginId: installed ? 601 : null,
    sourceType: 'marketplace',
    interface: {
      displayName: '快速建站',
      shortDescription: 'Build and deploy sites with Wegent',
      category: 'Productivity',
      defaultPrompt: ['Build an internal website and validate it locally'],
    },
    components: {
      skills: [
        {
          name: 'sites:sites-building',
          description: 'Build and validate sites',
          path: 'skills/sites-building/SKILL.md',
        },
      ],
      commands: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
    },
    manifest: { name: 'wegent-sites' },
    ownerUserId: 0,
  }
}

function installedSitesPlugin(deviceId = 'local-device') {
  const marketplacePlugin = sitesMarketplacePlugin(true)
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'wegent-sites',
      namespace: 'default',
      labels: { id: '601' },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent-marketplace',
        pluginKey: 'wegent-sites',
        catalogItemId: '501',
        marketplace: 'wegent',
      },
      displayName: '快速建站',
      description: marketplacePlugin.description,
      version: marketplacePlugin.version,
      author: marketplacePlugin.author,
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: marketplacePlugin.manifest,
      components: marketplacePlugin.components,
      interface: marketplacePlugin.interface,
      packageRef: {
        storageKey: 'skill-binaries/601',
        checksum: 'sha256:desktop-e2e-sites',
        sizeBytes: 1024,
      },
      sourcePayload: { filename: 'wegent-sites.zip' },
    },
    status: {
      state: 'Available',
      devices: [{ deviceId, state: 'installed' }],
    },
  }
}

function miniProgramMarketplacePlugin(installed) {
  return {
    id: 502,
    remotePluginId: 'wegent~Plugin_502',
    name: 'weibo-miniapp-h5-develop-agent',
    displayName: '微博小程序H5开发助手',
    description: 'Build and publish mini programs',
    version: '0.1.0',
    author: 'Wegent Team',
    visibility: 'public',
    featured: true,
    installed,
    enabled: installed,
    installedPluginId: installed ? 602 : null,
    sourceType: 'marketplace',
    interface: {
      displayName: '微博小程序H5开发助手',
      shortDescription: 'Build and publish mini programs with Wegent',
      category: 'Productivity',
      defaultPrompt: ['创建并发布一个小程序'],
    },
    components: {
      skills: [
        {
          name: 'mini-program:building',
          description: 'Build and publish mini programs',
          path: 'skills/building/SKILL.md',
        },
      ],
      commands: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
    },
    manifest: { name: 'weibo-miniapp-h5-develop-agent' },
    ownerUserId: 0,
  }
}

function installedMiniProgramPlugin(deviceId = 'local-device') {
  const marketplacePlugin = miniProgramMarketplacePlugin(true)
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'weibo-miniapp-h5-develop-agent',
      namespace: 'default',
      labels: { id: '602' },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent-marketplace',
        pluginKey: 'weibo-miniapp-h5-develop-agent',
        catalogItemId: '502',
        marketplace: 'wegent',
      },
      displayName: '微博小程序H5开发助手',
      description: marketplacePlugin.description,
      version: marketplacePlugin.version,
      author: marketplacePlugin.author,
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: marketplacePlugin.manifest,
      components: marketplacePlugin.components,
      interface: marketplacePlugin.interface,
      packageRef: {
        storageKey: 'skill-binaries/602',
        checksum: 'sha256:desktop-e2e-mini-program',
        sizeBytes: 1024,
      },
      sourcePayload: { filename: 'weibo-miniapp-h5-develop-agent.zip' },
    },
    status: {
      state: 'Available',
      devices: [{ deviceId, state: 'installed' }],
    },
  }
}

export {
  verifyInitialTelemetryConsent,
  declineInitialTelemetryConsent,
  ensureExperimentalFeaturesDisabled,
  ensureExperimentalFeaturesEnabled,
  verifySitesPluginAutoInstall,
  sitesMarketplacePlugin,
  installedSitesPlugin,
  miniProgramMarketplacePlugin,
  installedMiniProgramPlugin,
}
