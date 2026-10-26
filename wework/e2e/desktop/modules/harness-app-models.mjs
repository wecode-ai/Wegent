import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHarnessPackage, MODEL_LABEL } from './harness-app-fixture.mjs'
import { LOCAL_MODEL_CASES } from './shared.mjs'

/** Created by this checkpoint so its DSH profile pins the Wework default model. */
const INSTALLED_APP_ID = 'dsh-e2e-multi-model'
/** A second installation whose invalid profile patch keeps DSH from booting. */
const FAILING_APP_ID = 'dsh-e2e-model-failure'
/** A local model that lists normally but cannot register a proxy route. */
const UNAVAILABLE_MODEL_ID = 'desktop-e2e-unavailable-model'
const UNAVAILABLE_MODEL_LABEL = 'Desktop E2E Unavailable'
const LOCAL_MODEL_SETTINGS_STORAGE_KEY = 'wework.localModelSettings.v1'

const DEFAULT_MODEL = LOCAL_MODEL_CASES.find(model => model.protocol === 'chat')
const EXTRA_MODEL = LOCAL_MODEL_CASES.find(model => model.protocol === 'responses')
const UNAVAILABLE_MODEL_UPSTREAM = 'desktop-e2e-unavailable-upstream'

export async function verifyHarnessAppModels(
  control,
  { uiTimeoutMs, electronUserDataDirectory, resultDir, captureScreenshot }
) {
  assert.ok(DEFAULT_MODEL, 'Desktop E2E chat model fixture is missing')
  assert.ok(EXTRA_MODEL, 'Desktop E2E responses model fixture is missing')
  control.setScenario('harness_app_models')

  const readyCountBeforeSeed = control.readyCount
  await control.command('reloadMainWindow', 'body', {
    value: JSON.stringify({
      localStorage: {
        key: LOCAL_MODEL_SETTINGS_STORAGE_KEY,
        value: await withUnavailableModel(control),
      },
    }),
    timeoutMs: 90_000,
  })
  await control.awaitReadyAfter(readyCountBeforeSeed)
  await openOwnedApps(control, uiTimeoutMs)

  const packagePath = await createHarnessPackage(resultDir, INSTALLED_APP_ID, '0.1.0-rc.8', {
    cordisPatch: '[]\n',
  })
  await control.command('dropPaths', '[data-testid="smart-apps-owned-page"]', {
    value: JSON.stringify([
      {
        uri: pathToFileURL(packagePath).href,
        name: `${INSTALLED_APP_ID}.zip`,
        mimeType: 'application/zip',
      },
    ]),
  })
  await control.command('waitFor', `[data-testid="smart-app-created-item-${INSTALLED_APP_ID}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await selectHarnessAppModel(control, INSTALLED_APP_ID, MODEL_LABEL, uiTimeoutMs)
  await control.command(
    'clickWhenEnabled',
    `[data-testid="harness-app-start-${INSTALLED_APP_ID}"]`,
    { timeoutMs: 60_000 }
  )
  await control.command('waitFor', `[data-testid="harness-app-launch-${INSTALLED_APP_ID}"]`, {
    timeoutMs: 60_000,
  })
  await control.command('waitFor', `[data-testid="app-iframe-harness-${INSTALLED_APP_ID}"]`, {
    timeoutMs: 600_000,
  })
  await captureScreenshot(control, 'harness-apps-12-multi-model-started.png', 'body')

  const installation = await waitForRunningInstallation(
    electronUserDataDirectory,
    INSTALLED_APP_ID,
    30_000
  )
  const instanceDirectory = join(
    electronUserDataDirectory,
    'harness-apps',
    'instances',
    INSTALLED_APP_ID
  )
  const routes = parseHarnessModelRoutes(
    await readFile(join(instanceDirectory, 'settings.yaml'), 'utf8')
  )
  const defaultRoute = routes.find(route => route.id === 'wework-local')
  assert.ok(defaultRoute, 'The selected Wework model must keep the original default provider')
  const extraRoute = routes.find(route => route.displayName === EXTRA_MODEL.labels[1])
  assert.ok(extraRoute, 'The extra Wework model was not written as its own DSH provider')
  assert.notEqual(
    extraRoute.baseUrl,
    defaultRoute.baseUrl,
    'The extra Wework model reused the selected model proxy route'
  )
  assert.equal(
    routes.some(route => route.displayName === UNAVAILABLE_MODEL_LABEL),
    false,
    'A model whose proxy route failed was still registered as a DSH provider'
  )

  // DSH reads the generated settings itself; llm.models proves it loaded every
  // provider instead of this test only inspecting the file Wework wrote.
  const providerGroups = await waitForDshValue(
    () => dshRequest(installation.webUrl, 'llm.models', {}),
    value => value.groups.some(group => group.id === 'wework-local'),
    30_000
  ).then(value => value.groups)
  const defaultProvider = providerGroups.find(group => group.id === 'wework-local')
  assert.ok(defaultProvider, 'DSH did not expose the original default model provider')
  assert.deepEqual(
    defaultProvider.models.map(model => model.id),
    ['wework-selected'],
    'The default provider no longer exposes the selected Wework model'
  )
  const extraProvider = providerGroups.find(group => group.name === EXTRA_MODEL.labels[1])
  assert.ok(extraProvider, 'DSH did not load the extra Wework model provider')
  const extraModelId = extraProvider.models[0]?.id
  assert.ok(extraModelId, 'The extra Wework provider exposed no model')
  assert.equal(
    providerGroups.some(group => group.name === UNAVAILABLE_MODEL_LABEL),
    false,
    'DSH loaded a provider whose proxy route was never registered'
  )
  assert.equal(
    providerGroups.some(group => group.name === MODEL_LABEL),
    false,
    'The selected model must not be duplicated as an extra provider'
  )

  const workspace = join(resultDir, 'harness-app-models-workspace')
  await mkdir(workspace, { recursive: true })
  const { sessionId } = await dshRequest(installation.webUrl, 'session.create', { cwd: workspace })
  const sessionModels = await dshRequest(installation.webUrl, 'session.models', { sessionId })
  assert.deepEqual(
    { provider: sessionModels.current.provider, model: sessionModels.current.model },
    { provider: 'wework-local', model: 'wework-selected' },
    'A new DSH session did not start on the original default model route'
  )

  const defaultPrompt = `HARNESS_DEFAULT_MODEL_PROMPT_${randomUUID()}`
  await dshRequest(installation.webUrl, 'session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: defaultPrompt }],
  })
  await waitForHarnessModelRequest(control, defaultPrompt, DEFAULT_MODEL.modelId, 30_000)
  await waitForSessionIdle(installation.webUrl, sessionId, 30_000)

  await dshRequest(installation.webUrl, 'session.selectModel', {
    sessionId,
    provider: extraProvider.id,
    model: extraModelId,
  })
  const extraPrompt = `HARNESS_EXTRA_MODEL_PROMPT_${randomUUID()}`
  await dshRequest(installation.webUrl, 'session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: extraPrompt }],
  })
  const extraRequest = await waitForHarnessModelRequest(
    control,
    extraPrompt,
    EXTRA_MODEL.modelId,
    30_000
  )
  assert.notEqual(
    extraRequest.body.model,
    DEFAULT_MODEL.modelId,
    'Selecting the extra provider did not reach a different upstream model'
  )
  assert.equal(
    control.modelRequests.some(request => request.body?.model === UNAVAILABLE_MODEL_UPSTREAM),
    false,
    'A model with an incomplete proxy configuration still reached the model service'
  )
  await waitForSessionIdle(installation.webUrl, sessionId, 30_000)
  await captureScreenshot(control, 'harness-apps-13-multi-model-routes.png', 'body')

  // A failed launch must release the routes it registered before DSH started,
  // and it must not disturb the app that is already running.
  const failingPackagePath = await createHarnessPackage(resultDir, FAILING_APP_ID, '0.1.0-rc.8', {
    cordisPatch: '- id: [unterminated\n',
  })
  await control.command('dropPaths', '[data-testid="smart-apps-owned-page"]', {
    value: JSON.stringify([
      {
        uri: pathToFileURL(failingPackagePath).href,
        name: `${FAILING_APP_ID}.zip`,
        mimeType: 'application/zip',
      },
    ]),
  })
  await control.command('waitFor', `[data-testid="smart-app-created-item-${FAILING_APP_ID}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await selectHarnessAppModel(control, FAILING_APP_ID, MODEL_LABEL, uiTimeoutMs)
  await control.command('clickWhenEnabled', `[data-testid="harness-app-start-${FAILING_APP_ID}"]`, {
    timeoutMs: 60_000,
  })
  const failedRoutes = await waitForFailedLaunchRoutes(
    electronUserDataDirectory,
    FAILING_APP_ID,
    60_000
  )
  assert.ok(failedRoutes.length > 1, 'The failed launch never registered its model routes')
  await waitForReleasedRoutes(failedRoutes, 120_000)

  const afterFailurePrompt = `HARNESS_AFTER_FAILURE_PROMPT_${randomUUID()}`
  await dshRequest(installation.webUrl, 'session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: afterFailurePrompt }],
  })
  await waitForHarnessModelRequest(control, afterFailurePrompt, EXTRA_MODEL.modelId, 30_000)
  await waitForSessionIdle(installation.webUrl, sessionId, 30_000)

  await openOwnedApps(control, uiTimeoutMs)
  await control.command('click', `[data-testid="smart-app-actions-${INSTALLED_APP_ID}"]`)
  await control.command('waitFor', `[data-testid="smart-app-stop-menu-${INSTALLED_APP_ID}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', `[data-testid="smart-app-stop-menu-${INSTALLED_APP_ID}"]`)
  await control.command('waitFor', `[data-testid="harness-app-start-${INSTALLED_APP_ID}"]`, {
    timeoutMs: 60_000,
  })
  await Promise.all([
    assertHarnessRouteReleased(defaultRoute.baseUrl),
    assertHarnessRouteReleased(extraRoute.baseUrl),
  ])

  const readyCountBeforeCleanup = control.readyCount
  await control.command('reloadMainWindow', 'body', {
    value: JSON.stringify({
      localStorage: {
        key: LOCAL_MODEL_SETTINGS_STORAGE_KEY,
        value: await withoutUnavailableModel(control),
      },
    }),
    timeoutMs: 90_000,
  })
  await control.awaitReadyAfter(readyCountBeforeCleanup)
  await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
    timeoutMs: uiTimeoutMs,
  })
}

async function openOwnedApps(control, uiTimeoutMs) {
  await control.command('navigate', 'body', {
    value: '/sites?app_type=smart_app&view=owned',
  })
  await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="smart-apps-section-owned"]')
  await control.command('waitFor', '[data-testid="smart-apps-created-list"]', {
    timeoutMs: uiTimeoutMs,
  })
}

async function selectHarnessAppModel(control, installationId, label, uiTimeoutMs) {
  const selector = `[data-testid="harness-app-model-${installationId}"]`
  await control.command('waitFor', selector, {
    enabled: true,
    stableMs: 300,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('select', selector, { by: 'label', value: label })
  await control.command('waitFor', selector, {
    enabled: true,
    stableMs: 300,
    timeoutMs: uiTimeoutMs,
  })
}

async function readLocalModelConfigs(control) {
  const raw = await control.command('getLocalStorageItem', 'body', {
    value: LOCAL_MODEL_SETTINGS_STORAGE_KEY,
  })
  if (!raw) return []
  const parsed = JSON.parse(raw)
  assert.ok(Array.isArray(parsed), 'Local model settings are not an array')
  return parsed
}

async function withUnavailableModel(control) {
  const configs = await readLocalModelConfigs(control)
  return JSON.stringify([
    ...configs.filter(config => config.id !== UNAVAILABLE_MODEL_ID),
    {
      id: UNAVAILABLE_MODEL_ID,
      displayName: UNAVAILABLE_MODEL_LABEL,
      modelId: UNAVAILABLE_MODEL_UPSTREAM,
      // Route registration rejects an unusable URL, so listing this model
      // exercises the per-model failure path without failing the launch.
      baseUrl: '',
      apiFormat: 'openai-chat-completions',
      requestPath: '/chat/completions',
      toolProfile: 'function',
      enabled: true,
      catalogReady: true,
      updatedAt: new Date().toISOString(),
    },
  ])
}

async function withoutUnavailableModel(control) {
  const configs = await readLocalModelConfigs(control)
  return JSON.stringify(configs.filter(config => config.id !== UNAVAILABLE_MODEL_ID))
}

async function waitForRunningInstallation(userDataDirectory, installationId, timeoutMs) {
  const startedAt = Date.now()
  const registryPath = join(userDataDirectory, 'harness-apps', 'installations.json')
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const installations = JSON.parse(await readFile(registryPath, 'utf8'))
      const installation = installations.find(item => item.id === installationId)
      if (installation?.state === 'running' && installation.webUrl) return installation
    } catch {
      // The registry is rewritten while the app starts.
    }
    await delay(100)
  }
  throw new Error(`Smart app ${installationId} did not report a running DSH instance`)
}

function parseHarnessModelRoutes(settings) {
  const routes = []
  let current = null
  for (const line of settings.split('\n')) {
    const provider = /^ {4}([A-Za-z0-9_.:-]+):\s*$/.exec(line)
    if (provider) {
      current = { id: provider[1], displayName: '', baseUrl: '' }
      routes.push(current)
      continue
    }
    if (!current) continue
    const field = /^ {6}(displayName|baseURL):\s*(.+?)\s*$/.exec(line)
    if (!field) continue
    const value = field[2].startsWith('"') ? JSON.parse(field[2]) : field[2]
    if (field[1] === 'displayName') current.displayName = value
    else current.baseUrl = value
  }
  return routes.filter(route => route.baseUrl)
}

async function dshRequest(baseUrl, method, payload) {
  const response = await fetch(new URL(`api/${method}`, normalizeBaseUrl(baseUrl)), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  assert.equal(response.ok, true, `DSH ${method} returned HTTP ${response.status}`)
  const message = await response.json()
  assert.equal(message.type, 'server-response', `DSH ${method} returned an unexpected message`)
  assert.equal(
    message.result.ok,
    true,
    `DSH ${method} failed: ${JSON.stringify(message.result.error)}`
  )
  return message.result.value
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

async function waitForDshValue(read, accept, timeoutMs) {
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await read()
      if (accept(value)) return value
    } catch (error) {
      lastError = error
    }
    await delay(200)
  }
  if (lastError) throw lastError
  throw new Error('DSH did not expose the expected model providers')
}

async function waitForSessionIdle(baseUrl, sessionId, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const { items } = await dshRequest(baseUrl, 'session.list', {})
    const session = items.find(item => item.sessionId === sessionId)
    if (session && !session.running) return
    await delay(100)
  }
  throw new Error(`DSH session ${sessionId} did not finish its turn`)
}

async function waitForHarnessModelRequest(control, prompt, expectedModelId, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const request = control.modelRequests.find(
      entry =>
        entry.scenario === 'harness_app_models' && JSON.stringify(entry.body ?? {}).includes(prompt)
    )
    if (request) {
      assert.equal(
        request.body.model,
        expectedModelId,
        `The harness app reached ${request.body.model} instead of ${expectedModelId}`
      )
      return request
    }
    await delay(100)
  }
  throw new Error(`The harness app never sent its model request to ${expectedModelId}`)
}

async function waitForFailedLaunchRoutes(userDataDirectory, installationId, timeoutMs) {
  const startedAt = Date.now()
  const settingsPath = join(
    userDataDirectory,
    'harness-apps',
    'instances',
    installationId,
    'settings.yaml'
  )
  let routes = []
  while (Date.now() - startedAt < timeoutMs) {
    try {
      routes = parseHarnessModelRoutes(await readFile(settingsPath, 'utf8'))
      if (routes.length > 1) break
    } catch {
      // The launch has not written its runtime settings yet.
    }
    await delay(100)
  }
  assert.ok(routes.length > 1, 'The failed launch never wrote its model routes')
  return routes
}

async function assertHarnessRouteReleased(baseUrl) {
  assert.equal(
    await isHarnessRouteReleased(baseUrl),
    true,
    `Harness model route ${baseUrl} still accepted requests after release`
  )
}

async function waitForReleasedRoutes(routes, timeoutMs) {
  const startedAt = Date.now()
  let remaining = routes
  while (Date.now() - startedAt < timeoutMs) {
    remaining = []
    for (const route of routes) {
      if (!(await isHarnessRouteReleased(route.baseUrl))) remaining.push(route)
    }
    if (!remaining.length) return
    await delay(200)
  }
  throw new Error(
    `Harness model routes were not released after the failed launch: ${remaining
      .map(route => route.displayName || route.id)
      .join(', ')}`
  )
}

async function isHarnessRouteReleased(baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'wework-local-router' },
    body: JSON.stringify({
      model: 'wework-selected',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'route release probe' }],
    }),
    signal: AbortSignal.timeout(10_000),
  })
  return response.status === 404
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
