import { waitForSnapshot } from './conversation-layout.mjs'

import { telemetryEvents } from './response-protocol.mjs'

import {
  DEFAULT_STEP_TIMEOUT_MS,
  TELEMETRY_FORBIDDEN_PROPERTY_PATTERN,
  TELEMETRY_SAFE_PROPERTY_KEYS,
  TELEMETRY_TEST_PROJECT_KEY,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
} from './shared.mjs'

import { captureVerificationScreenshot, waitForAttribute } from './workspace-flows.mjs'

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
          // Background plugin synchronization can finish after consent is accepted.
          plugin_auto_update_succeeded: true,
          telemetry_preference_changed: true,
          // An automatic update can finish after consent and share the startup batch.
          plugin_auto_update_succeeded: true,
        },
        event.event
      ),
      true,
      `The initial telemetry request contained an unexpected event: ${event.event}`
    )
    assert.ok(event.properties && typeof event.properties === 'object')
    if (event.event === 'plugin_auto_update_succeeded') {
      assert.equal(event.properties.domain, 'plugin')
    }
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
  verifySitesAccessConfiguration,
  sitesMarketplacePlugin,
  installedSitesPlugin,
  miniProgramMarketplacePlugin,
  installedMiniProgramPlugin,
}

async function verifySitesAccessConfiguration(control) {
  await navigateToApplications(control)
  await control.command('waitFor', '[data-testid="site-row-prj_e2e_product"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
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
}
