import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_STEP_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  pathExists,
  withTimeout,
} from './shared.mjs'
import {
  ensureExperimentalFeaturesDisabled,
  ensureExperimentalFeaturesEnabled,
} from './preferences-automation-flows.mjs'

const ROOT_SELECTOR = '[data-testid="wework-dsh-root"]'
const DESKTOP_HOST_INVOKE_PATH = '/wework/electron-host/v1/invoke'
const UI_PLUGINS = [
  {
    name: '@wegent/dsh-ui-core-apps',
    directory: 'wework-ui-core-apps',
    slot: 'wework.app',
    contributions: ['wework', 'todo', 'wegent'],
    navigation: null,
    route: null,
    testId: null,
  },
  {
    name: '@wegent/dsh-ui-core-settings',
    directory: 'wework-ui-core-settings',
    slot: 'wework.settings.page',
    contributions: [
      'general',
      'connections',
      'appearance',
      'context',
      'model-settings',
      'proxy',
      'keyboard-shortcuts',
      'quick-phrases',
      'runtimes',
      'about',
      'appshots',
      'plugins',
      'browser',
      'execution-environments',
      'harnesses',
      'hooks',
      'archived-conversations',
    ],
    navigation: null,
    route: '/settings/appearance',
    testId: 'appearance-settings-page',
  },
  {
    name: '@wegent/dsh-ui-git',
    directory: 'wework-ui-git',
    slot: 'wework.settings.page',
    contributions: ['git-hosting', 'worktrees'],
    navigation: null,
    route: '/settings/git-hosting',
    testId: 'git-hosting-settings-page',
  },
  {
    name: '@wegent/dsh-ui-plugin-center',
    directory: 'wework-ui-plugin-center',
    slot: 'wework.route',
    contributions: ['plugin-center.catalog', 'plugin-center.create', 'plugin-center.management'],
    navigation: { id: 'plugin-center.navigation', testId: 'plugins-button' },
    route: '/plugins',
    testId: 'plugins-workspace',
  },
  {
    name: '@wegent/dsh-ui-applications',
    directory: 'wework-ui-applications',
    slot: 'wework.route',
    contributions: ['applications.sites'],
    navigation: { id: 'applications.navigation', testId: 'sites-button' },
    route: '/sites',
    testId: 'sites-workspace',
  },
  {
    name: '@wegent/dsh-ui-automations',
    directory: 'wework-ui-automations',
    slot: 'wework.route',
    contributions: ['automations.root'],
    navigation: { id: 'automations.navigation', testId: 'automation-button' },
    route: '/automations',
    testId: 'create-automation-button',
  },
  {
    name: '@wegent/dsh-ui-cloud-work',
    directory: 'wework-ui-cloud-work',
    slot: 'wework.route',
    contributions: ['cloud-work.root'],
    navigation: {
      id: 'cloud-work.navigation',
      testId: 'sidebar-cloud-connection-button',
    },
    route: '/cloud-work',
    testId: 'cloud-work-page',
  },
]
const DEMO_PLUGIN = {
  name: '@wegent/dsh-wework-extension-demo',
  directory: fileURLToPath(new URL('../../../dsh/examples/ui-extension-demo', import.meta.url)),
  contributions: {
    'wework.action': ['dsh-extension-demo.open'],
    'wework.app': ['dsh-extension-demo'],
    'wework.route': ['dsh-extension-demo.route'],
    'wework.sidebar.navigation': ['dsh-extension-demo.navigation'],
    'wework.settings.page': ['dsh-extension-demo.settings'],
    'wework.workspace.tab': ['dsh-extension-demo.workspace'],
    'wework.workspace.sidebar.tab': ['dsh-extension-demo.inspector'],
    'wework.shell.before': ['dsh-extension-demo.before'],
    'wework.shell.after': ['dsh-extension-demo.after'],
    'wework.shell.overlay': ['dsh-extension-demo.overlay'],
  },
}

export async function verifyCoreDshUiPluginComposition({
  control,
  initialRendererLocation,
  pluginsRoot,
  restartDesktopApp,
  runtimeRoot,
}) {
  const pluginSources = await resolveCoreUiPluginSources(runtimeRoot, pluginsRoot)
  let rendererOrigin = new URL(initialRendererLocation).origin
  const installedContributions = new Map()

  await waitForSlotState(control, slots =>
    UI_PLUGINS.every(plugin =>
      plugin.contributions.every(contribution => !slots[plugin.slot]?.includes(contribution))
    )
  )
  await ensureExperimentalFeaturesEnabled(control)
  for (const plugin of UI_PLUGINS) {
    await assertFeatureAbsent(control, plugin)
  }

  for (const plugin of UI_PLUGINS) {
    const before = await readSlots(control)
    for (const contribution of plugin.contributions) {
      assert.equal(
        before[plugin.slot]?.includes(contribution),
        false,
        `${plugin.name} contributed ${contribution} before it was installed`
      )
    }
    if (plugin.navigation) {
      assert.equal(
        before['wework.sidebar.navigation']?.includes(plugin.navigation.id),
        false,
        `${plugin.name} contributed sidebar navigation before it was installed`
      )
    }

    const plugins = await invokeCoreDshPluginCapability(
      rendererOrigin,
      'runtime.installCoreDshPlugin',
      {
        spec: `file:${pluginSources.get(plugin.name)}`,
      }
    )
    const installed = plugins.find(item => item.name === plugin.name)
    assert.ok(
      installed,
      `${plugin.name} was absent from the Core DSH plugin inventory after install`
    )
    assert.equal(installed.enabled, true, `${plugin.name} was not enabled after install`)

    await restartDesktopApp()
    rendererOrigin = await control.command('getLocationOrigin', 'body')
    await dismissCodexHomeInitializer(control)
    installedContributions.set(plugin.slot, [
      ...(installedContributions.get(plugin.slot) ?? []),
      ...plugin.contributions,
    ])
    if (plugin.navigation) {
      installedContributions.set('wework.sidebar.navigation', [
        ...(installedContributions.get('wework.sidebar.navigation') ?? []),
        plugin.navigation.id,
      ])
    }

    await waitForSlotState(control, slots =>
      [...installedContributions].every(([slot, contributions]) =>
        contributions.every(contribution => slots[slot]?.includes(contribution))
      )
    )
    await assertInstalledFeatureVisible(control, plugin)
  }

  for (const plugin of UI_PLUGINS.filter(
    candidate =>
      candidate.name === '@wegent/dsh-ui-applications' ||
      candidate.name === '@wegent/dsh-ui-cloud-work'
  )) {
    rendererOrigin = await setPluginEnabledAndRestart(
      control,
      rendererOrigin,
      restartDesktopApp,
      plugin,
      false
    )
    await waitForSlotState(
      control,
      slots =>
        !slots[plugin.slot]?.some(contribution => plugin.contributions.includes(contribution)) &&
        !slots['wework.sidebar.navigation']?.includes(plugin.navigation.id)
    )
    await assertFeatureAbsent(control, plugin)

    rendererOrigin = await setPluginEnabledAndRestart(
      control,
      rendererOrigin,
      restartDesktopApp,
      plugin,
      true
    )
    await waitForSlotState(
      control,
      slots =>
        plugin.contributions.every(contribution => slots[plugin.slot]?.includes(contribution)) &&
        slots['wework.sidebar.navigation']?.includes(plugin.navigation.id)
    )
    await assertInstalledFeatureVisible(control, plugin)
  }

  rendererOrigin = await installDemoPlugin({
    control,
    pluginSource: pluginSources.get(DEMO_PLUGIN.name),
    rendererOrigin,
    restartDesktopApp,
  })
  await assertDemoPluginVisible(control)

  rendererOrigin = await setPluginEnabledAndRestart(
    control,
    rendererOrigin,
    restartDesktopApp,
    DEMO_PLUGIN,
    false
  )
  await assertDemoPluginAbsent(control)

  rendererOrigin = await setPluginEnabledAndRestart(
    control,
    rendererOrigin,
    restartDesktopApp,
    DEMO_PLUGIN,
    true
  )
  await assertDemoPluginVisible(control)

  const afterUninstall = await invokeCoreDshPluginCapability(
    rendererOrigin,
    'runtime.uninstallCoreDshPlugin',
    { name: DEMO_PLUGIN.name }
  )
  assert.equal(
    afterUninstall.some(item => item.name === DEMO_PLUGIN.name),
    false,
    `${DEMO_PLUGIN.name} remained in the Core DSH inventory after uninstall`
  )
  await restartDesktopApp()
  await dismissCodexHomeInitializer(control)
  rendererOrigin = await control.command('getLocationOrigin', 'body')
  await assertDemoPluginAbsent(control)

  const inventory = await readCoreDshPlugins(rendererOrigin)
  for (const plugin of UI_PLUGINS) {
    const installed = inventory.find(item => item.name === plugin.name)
    assert.ok(installed, `${plugin.name} was missing from the final Core DSH plugin inventory`)
    assert.equal(installed.enabled, true, `${plugin.name} was disabled in the final inventory`)
  }
  await control.command('navigate', 'body', { value: '/' })
  await ensureExperimentalFeaturesDisabled(control)
}

async function installDemoPlugin({ control, pluginSource, rendererOrigin, restartDesktopApp }) {
  assert.ok(pluginSource, `${DEMO_PLUGIN.name} source is unavailable`)
  await assertDemoPluginAbsent(control)
  const plugins = await invokeCoreDshPluginCapability(
    rendererOrigin,
    'runtime.installCoreDshPlugin',
    { spec: `file:${pluginSource}` }
  )
  const installed = plugins.find(item => item.name === DEMO_PLUGIN.name)
  assert.ok(installed, `${DEMO_PLUGIN.name} was absent after install`)
  assert.equal(installed.enabled, true, `${DEMO_PLUGIN.name} was disabled after install`)
  await restartDesktopApp()
  await dismissCodexHomeInitializer(control)
  return control.command('getLocationOrigin', 'body')
}

async function assertDemoPluginVisible(control) {
  await waitForSlotState(control, slots =>
    Object.entries(DEMO_PLUGIN.contributions).every(([slot, ids]) =>
      ids.every(id => slots[slot]?.includes(id))
    )
  )
  await control.command('waitFor', '[data-testid="dsh-extension-demo-overlay"]')
  assert.equal(
    Number(
      await control.command('getElementCount', '[data-testid="dsh-extension-demo-shell-before"]')
    ),
    1,
    'Demo shell-before component was not mounted'
  )
  assert.equal(
    Number(
      await control.command('getElementCount', '[data-testid="dsh-extension-demo-shell-after"]')
    ),
    1,
    'Demo shell-after component was not mounted'
  )

  await control.command('click', '[data-testid="dsh-extension-demo-navigation"]')
  await control.command('waitFor', '[data-testid="dsh-extension-demo-route"]')
  await control.command('click', '[data-testid="dsh-extension-demo-open-settings"]')
  await control.command('waitFor', '[data-testid="dsh-extension-demo-settings"]')

  await control.command('navigate', 'body', { value: '/app/dsh-extension-demo' })
  await control.command('waitFor', '[data-testid="dsh-extension-demo-app"]')

  await control.command('navigate', 'body', { value: '/' })
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command(
    'click',
    '[data-testid="workspace-tab-add-dsh-dsh-extension-demo.workspace"]'
  )
  await control.command('waitFor', '[data-testid="dsh-extension-demo-workspace-tab"]')
}

async function assertDemoPluginAbsent(control) {
  await waitForSlotState(control, slots =>
    Object.entries(DEMO_PLUGIN.contributions).every(([slot, ids]) =>
      ids.every(id => !slots[slot]?.includes(id))
    )
  )
  for (const selector of [
    '[data-testid="dsh-extension-demo-navigation"]',
    '[data-testid="dsh-extension-demo-overlay"]',
    '[data-testid="dsh-extension-demo-route"]',
    '[data-testid="dsh-extension-demo-settings"]',
    '[data-testid="dsh-extension-demo-app"]',
    '[data-testid="dsh-extension-demo-workspace-tab"]',
  ]) {
    assert.equal(
      Number(await control.command('getElementCount', selector)),
      0,
      `${selector} remained mounted after the Demo plugin was removed`
    )
  }
  await control.command('navigate', 'body', { value: '/' })
}

async function assertFeatureAbsent(control, plugin) {
  if (plugin.navigation) {
    assert.equal(
      Number(
        await control.command('getElementCount', `[data-testid="${plugin.navigation.testId}"]`)
      ),
      0,
      `${plugin.name} sidebar navigation was visible before the plugin was installed`
    )
  }
  if (!plugin.route || !plugin.testId) return
  await control.command('navigate', 'body', { value: plugin.route })
  assert.equal(
    Number(await control.command('getElementCount', `[data-testid="${plugin.testId}"]`)),
    0,
    `${plugin.name} functionality was visible before the plugin was installed`
  )
}

async function assertInstalledFeatureVisible(control, plugin) {
  if (plugin.navigation) {
    await control.command('waitFor', `[data-testid="${plugin.navigation.testId}"]`, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
  }
  if (!plugin.route || !plugin.testId) return
  await control.command('navigate', 'body', { value: plugin.route })
  await control.command('waitFor', `[data-testid="${plugin.testId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

async function setPluginEnabledAndRestart(control, origin, restartDesktopApp, plugin, enabled) {
  const plugins = await invokeCoreDshPluginCapability(origin, 'runtime.setCoreDshPluginEnabled', {
    name: plugin.name,
    enabled,
  })
  const updated = plugins.find(item => item.name === plugin.name)
  assert.ok(updated, `${plugin.name} was absent after changing enabled state`)
  assert.equal(updated.enabled, enabled, `${plugin.name} enabled state did not change`)

  await restartDesktopApp()
  await dismissCodexHomeInitializer(control)
  return control.command('getLocationOrigin', 'body')
}

async function dismissCodexHomeInitializer(control) {
  const selector = '[data-testid="codex-home-initializer-dialog"]'
  if (Number(await control.command('getElementCount', selector)) === 0) return
  await control.command('click', '[data-testid="codex-home-initializer-create-button"]')
  await withTimeout(
    (async () => {
      while (Number(await control.command('getElementCount', selector)) > 0) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
      }
    })(),
    DEFAULT_STEP_TIMEOUT_MS,
    'Codex home initializer remained visible after choosing not to import'
  )
}

async function readSlots(control) {
  await control.command('waitFor', ROOT_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  return JSON.parse(
    await control.command('getAttribute', ROOT_SELECTOR, {
      value: 'data-wework-dsh-slots',
    })
  )
}

async function waitForSlotState(control, predicate) {
  const startedAt = Date.now()
  let lastSlots = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    lastSlots = await readSlots(control)
    if (predicate(lastSlots)) return lastSlots
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  assert.fail(`Core DSH slot state did not settle: ${JSON.stringify(lastSlots)}`)
}

async function invokeCoreDshPluginCapability(origin, capability, params = {}) {
  const response = await fetch(`${origin}${DESKTOP_HOST_INVOKE_PATH}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ capability, params }),
  })
  const payload = await response.json()
  assert.equal(
    response.ok,
    true,
    `Core DSH plugin capability ${capability} failed: ${payload.error?.message ?? response.status}`
  )
  assert.equal(
    payload.ok,
    true,
    `Core DSH plugin capability ${capability} returned an error: ${payload.error?.message}`
  )
  return payload.result
}

async function readCoreDshPlugins(origin) {
  return invokeCoreDshPluginCapability(origin, 'runtime.listCoreDshPlugins')
}

async function resolveCoreUiPluginSources(runtimeRoot, pluginsRoot) {
  assert.ok(runtimeRoot, 'Core DSH UI plugin composition requires WEWORK_HARNESS_RUNTIME_ROOT')
  assert.ok(pluginsRoot, 'Core DSH UI plugin composition requires the packaged Core plugin root')
  const roots = await runtimeCandidates(resolve(runtimeRoot))
  const matching = (
    await Promise.all(
      roots.map(async root => {
        const identity = await readJson(join(root, 'runtime.json'))
        return identity?.role === 'core' ? root : null
      })
    )
  ).filter(Boolean)
  assert.equal(
    matching.length,
    1,
    `Expected one bundled Core DSH runtime, found ${matching.join(', ')}`
  )
  const sources = new Map(
    UI_PLUGINS.map(plugin => [plugin.name, join(resolve(pluginsRoot), plugin.directory)])
  )
  sources.set(DEMO_PLUGIN.name, DEMO_PLUGIN.directory)
  const missing = (
    await Promise.all(
      [...sources].map(async ([name, source]) => [
        name,
        (await pathExists(join(source, 'package.json'))) ? null : source,
      ])
    )
  ).filter(([, source]) => source)
  assert.deepEqual(missing, [], `Packaged Core DSH plugins are unavailable: ${missing.join(', ')}`)
  return sources
}

async function runtimeCandidates(root) {
  if (await pathExists(join(root, 'runtime.json'))) return [root]
  const catalog = await readJson(join(root, 'runtimes.json'))
  if (Array.isArray(catalog?.runtimes)) {
    return catalog.runtimes
      .map(runtime => runtime?.sourceFingerprint)
      .filter(fingerprint => typeof fingerprint === 'string')
      .map(fingerprint => join(root, fingerprint))
  }
  return (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => join(root, entry.name))
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}
