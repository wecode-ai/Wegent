import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  DEFAULT_STEP_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  pathExists,
  withTimeout,
} from './shared.mjs'

const ROOT_SELECTOR = '[data-testid="wework-dsh-root"]'
const PLUGIN_API_PATH = '/wework/dsh/plugins'
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
      'git-hosting',
      'execution-environments',
      'harnesses',
      'worktrees',
      'hooks',
      'archived-conversations',
    ],
    navigation: null,
    route: '/settings/appearance',
    testId: 'appearance-settings-page',
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

export async function verifyCoreDshUiPluginComposition({
  control,
  initialRendererLocation,
  runtimeRoot,
}) {
  const pluginSources = await resolveCoreUiPluginSources(runtimeRoot)
  let rendererOrigin = new URL(initialRendererLocation).origin
  const installedContributions = new Map()

  await waitForSlotState(control, slots =>
    UI_PLUGINS.every(plugin =>
      plugin.contributions.every(contribution => !slots[plugin.slot]?.includes(contribution))
    )
  )
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

    const response = await mutateCoreDshPlugins(rendererOrigin, 'install', {
      spec: `file:${pluginSources.get(plugin.name)}`,
    })
    const installed = response.result.plugins.find(item => item.name === plugin.name)
    assert.ok(
      installed,
      `${plugin.name} was absent from the Core DSH plugin inventory after install`
    )
    assert.equal(installed.active, true, `${plugin.name} was not activated after install`)

    const readyCount = control.readyCount
    await mutateCoreDshPlugins(rendererOrigin, 'restart', {})
    const ready = await withTimeout(
      control.awaitReadyAfter(readyCount),
      WORKBENCH_READY_TIMEOUT_MS,
      `Core DSH did not reconnect after installing ${plugin.name}`
    )
    rendererOrigin = new URL(ready.location).origin
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
    rendererOrigin = await setPluginActiveAndRestart(control, rendererOrigin, plugin, false)
    await waitForSlotState(
      control,
      slots =>
        !slots[plugin.slot]?.some(contribution => plugin.contributions.includes(contribution)) &&
        !slots['wework.sidebar.navigation']?.includes(plugin.navigation.id)
    )
    await assertFeatureAbsent(control, plugin)

    rendererOrigin = await setPluginActiveAndRestart(control, rendererOrigin, plugin, true)
    await waitForSlotState(
      control,
      slots =>
        plugin.contributions.every(contribution => slots[plugin.slot]?.includes(contribution)) &&
        slots['wework.sidebar.navigation']?.includes(plugin.navigation.id)
    )
    await assertInstalledFeatureVisible(control, plugin)
  }

  const inventory = await readCoreDshPlugins(rendererOrigin)
  for (const plugin of UI_PLUGINS) {
    const installed = inventory.plugins.find(item => item.name === plugin.name)
    assert.ok(installed, `${plugin.name} was missing from the final Core DSH plugin inventory`)
    assert.equal(installed.active, true, `${plugin.name} was inactive in the final inventory`)
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
  if (plugin.name === '@wegent/dsh-ui-core-settings') {
    await control.command('navigate', 'body', { value: '/' })
    await control.command('click', '[data-testid="settings-button"]')
    await control.command('click', '[data-testid="settings-menu-button"]')
    await control.command('waitFor', '[data-testid="settings-nav-appearance"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="settings-nav-appearance"]')
  } else {
    await control.command('navigate', 'body', { value: plugin.route })
  }
  await control.command('waitFor', `[data-testid="${plugin.testId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

async function setPluginActiveAndRestart(control, origin, plugin, active) {
  const response = await mutateCoreDshPlugins(origin, active ? 'activate' : 'deactivate', {
    name: plugin.name,
  })
  const updated = response.result.plugins.find(item => item.name === plugin.name)
  assert.ok(updated, `${plugin.name} was absent after changing activation state`)
  assert.equal(updated.active, active, `${plugin.name} activation state did not change`)

  const readyCount = control.readyCount
  await mutateCoreDshPlugins(origin, 'restart', {})
  const ready = await withTimeout(
    control.awaitReadyAfter(readyCount),
    WORKBENCH_READY_TIMEOUT_MS,
    `Core DSH did not reconnect after ${active ? 'activating' : 'deactivating'} ${plugin.name}`
  )
  return new URL(ready.location).origin
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

async function mutateCoreDshPlugins(origin, action, body) {
  const response = await fetch(`${origin}${PLUGIN_API_PATH}/${action}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json()
  assert.equal(
    response.ok,
    true,
    `Core DSH plugin ${action} failed: ${payload.error?.message ?? response.status}`
  )
  return payload
}

async function readCoreDshPlugins(origin) {
  const response = await fetch(`${origin}${PLUGIN_API_PATH}`, {
    headers: { accept: 'application/json' },
  })
  const payload = await response.json()
  assert.equal(
    response.ok,
    true,
    `Reading Core DSH plugins failed: ${payload.error?.message ?? response.status}`
  )
  return payload
}

async function resolveCoreUiPluginSources(runtimeRoot) {
  assert.ok(runtimeRoot, 'Core DSH UI plugin composition requires WEWORK_HARNESS_RUNTIME_ROOT')
  const roots = await runtimeCandidates(resolve(runtimeRoot))
  const matching = []
  for (const root of roots) {
    const identity = await readJson(join(root, 'runtime.json'))
    if (identity?.role !== 'core') continue
    const sources = new Map(
      UI_PLUGINS.map(plugin => [plugin.name, join(root, 'plugins', plugin.directory)])
    )
    if (
      await Promise.all(
        [...sources.values()].map(source => pathExists(join(source, 'package.json')))
      ).then(results => results.every(Boolean))
    ) {
      matching.push({ root, sources })
    }
  }
  assert.equal(
    matching.length,
    1,
    `Expected one bundled Core DSH runtime with Wework UI plugins, found ${matching
      .map(item => item.root)
      .join(', ')}`
  )
  return matching[0].sources
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
