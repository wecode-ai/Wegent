import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createHarnessPackage,
  MODEL_LABEL,
  setExperimentalFeatures,
  confirmHarnessInstallation,
  invokeHarnessHost as invokeHost,
} from './harness-app-fixture.mjs'
import { LOCAL_MODEL_CASES } from './shared.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'
import { fetchLocalRuntime } from './runtime-request.mjs'
import {
  readActiveHarnessModelRoutes,
  readPendingHarnessModelRoutes,
} from './harness-app-model-configuration.mjs'

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

  await setExperimentalFeatures(control, true, uiTimeoutMs)
  await verifyCoreDshModels(control)
  const readyCountBeforeSeed = control.readyCount
  await control.command('reloadMainWindow', 'body', { timeoutMs: 90_000 })
  await control.awaitReadyAfter(readyCountBeforeSeed)
  await injectInvalidLegacyModelForRejectionTest(control)
  await openSmartAppsTab(control, uiTimeoutMs)
  await openOwnedApps(control, uiTimeoutMs)

  const packagePath = await createHarnessPackage(resultDir, INSTALLED_APP_ID, '0.2.0-rc.2', {
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
  await confirmHarnessInstallation(control, uiTimeoutMs)
  await control.command('waitFor', `[data-testid="smart-app-created-item-${INSTALLED_APP_ID}"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await invokeHost(control, 'smartApps.configure', {
    installationId: INSTALLED_APP_ID,
    background: false,
  })
  await selectHarnessAppModel(control, INSTALLED_APP_ID, MODEL_LABEL, uiTimeoutMs)
  const ownedTabId = await control.command(
    'getAttribute',
    '[data-workspace-tab-content][aria-hidden="false"]',
    { value: 'data-workspace-tab-content' }
  )
  assert.ok(ownedTabId, 'The owned Smart apps page did not own a workspace tab')
  const gates = runtimeTransportGates(control)
  await startWithCatalogRefresh(control, { gates, uiTimeoutMs, resultDir })
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
  const routes = await waitForActiveHarnessModelRoutes(instanceDirectory)
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

  // DSH reads the generated settings itself; its catalog proves it loaded every
  // provider instead of this test only inspecting the file Wework wrote.
  const providerGroups = await waitForDshValue(
    () => dshRequest(control, installation.webUrl, 'session/modelCatalog', {}),
    value => value.groups.some(group => group.id === 'wework-local'),
    30_000
  ).then(value => value.groups)
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

  const sessionId = await exerciseModelRoutes(control, installation, {
    resultDir,
    screenshotName: 'harness-apps-13-multi-model-routes.png',
    captureScreenshot,
  })

  // A failed launch must release the routes it registered before DSH started,
  // and it must not disturb the app that is already running.
  const failingPackagePath = await createHarnessPackage(resultDir, FAILING_APP_ID, '0.2.0-rc.2', {
    cordisPatch: '- id: [unterminated\n',
  })
  await selectOwnedAppsTab(control, ownedTabId, uiTimeoutMs)
  await control.command('dropPaths', '[data-testid="smart-apps-owned-page"]', {
    value: JSON.stringify([
      {
        uri: pathToFileURL(failingPackagePath).href,
        name: `${FAILING_APP_ID}.zip`,
        mimeType: 'application/zip',
      },
    ]),
  })
  await confirmHarnessInstallation(control, uiTimeoutMs)
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
  await dshRequest(control, installation.webUrl, 'session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: afterFailurePrompt }],
    },
  })
  await waitForHarnessModelRequest(control, afterFailurePrompt, EXTRA_MODEL.modelId, 30_000)
  await waitForSessionIdle(control, installation.webUrl, sessionId, 30_000)

  // With background disabled, closing the independent view releases every route.
  await closeHarnessAppView(control, INSTALLED_APP_ID, uiTimeoutMs)
  await waitForReleasedRoutes([defaultRoute, extraRoute], 60_000)

  const reopened = await startInstalledHarnessApp(control, INSTALLED_APP_ID, {
    uiTimeoutMs,
    electronUserDataDirectory,
  })
  const reopenedRoutes = await waitForActiveHarnessModelRoutes(instanceDirectory)
  const reopenedDefaultRoute = reopenedRoutes.find(route => route.id === 'wework-local')
  const reopenedExtraRoute = reopenedRoutes.find(
    route => route.displayName === EXTRA_MODEL.labels[1]
  )
  assert.ok(reopenedDefaultRoute, 'Reopening the Smart app lost the default model route')
  assert.ok(reopenedExtraRoute, 'Reopening the Smart app lost the extra model route')
  await exerciseModelRoutes(control, reopened, {
    resultDir,
    screenshotName: 'harness-apps-14-reopened-model-routes.png',
    captureScreenshot,
  })

  await closeHarnessAppView(control, INSTALLED_APP_ID, uiTimeoutMs)
  await waitForReleasedRoutes([reopenedDefaultRoute, reopenedExtraRoute], 60_000)

  await verifyStopDuringHeldLaunchResponse(control, {
    gates,
    ownedTabId,
    uiTimeoutMs,
    electronUserDataDirectory,
    instanceDirectory,
    resultDir,
    captureScreenshot,
  })

  const readyCountBeforeCleanup = control.readyCount
  await control.command('removeLocalStorageItem', 'body', {
    value: LOCAL_MODEL_SETTINGS_STORAGE_KEY,
  })
  await control.command('reloadMainWindow', 'body', { timeoutMs: 90_000 })
  await control.awaitReadyAfter(readyCountBeforeCleanup)
  await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
    timeoutMs: uiTimeoutMs,
  })
}

async function verifyCoreDshModels(control) {
  const coreUrl = await control.command('getLocationOrigin', 'body')
  const labels = [MODEL_LABEL, EXTRA_MODEL.labels[1]]
  const catalog = await waitForDshValue(
    () => dshRequest(control, coreUrl, 'session/modelCatalog', {}),
    value =>
      labels.every(label =>
        value.groups.some(group => group.id.startsWith('wework-model-') && group.name === label)
      ),
    30_000
  )
  for (const label of labels) {
    const provider = catalog.groups.find(
      group => group.id.startsWith('wework-model-') && group.name === label
    )
    assert.deepEqual(
      provider.models.map(model => model.id),
      ['wework-selected'],
      `Core DSH did not receive the synchronized Wework model ${label}`
    )
  }
}

async function armHostResponse(gates, id, name, hold = true) {
  await gates.arm({
    id,
    kind: 'response',
    name,
    where: [{ path: 'params.installationId', equals: INSTALLED_APP_ID }],
    hold,
  })
}

async function startWithCatalogRefresh(control, { gates, uiTimeoutMs, resultDir }) {
  const id = 'catalog-refresh-open'
  try {
    await armHostResponse(gates, id, 'smartApps.open')
    await control.command(
      'clickWhenEnabled',
      `[data-testid="harness-app-start-${INSTALLED_APP_ID}"]`,
      { timeoutMs: 60_000 }
    )
    await gates.wait(id, undefined, 600_000)
    const running = await workbenchState(control, INSTALLED_APP_ID)
    assert.equal(
      running.running,
      true,
      'The Host did not start while its renderer response was held'
    )
    assert.equal(running.presentation, 'window')
    await refreshModelCatalogDuringLaunch(control, uiTimeoutMs)
    await gates.release(id)
    await waitForDshValue(
      () => workbenchState(control, INSTALLED_APP_ID),
      value => value.running && value.visible,
      30_000
    )
  } finally {
    await gates.save(resultDir, 'harness-model-catalog-refresh.json', [id])
    await gates.reset()
  }
}

async function selectOwnedAppsTab(control, tabId, uiTimeoutMs) {
  const tabSelector = `[data-testid="workspace-tab-select-${tabId}"]`
  await control.command('click', tabSelector)
  await control.command('waitFor', `${tabSelector}[aria-selected="true"]`, {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
}

async function refreshModelCatalogDuringLaunch(control, uiTimeoutMs) {
  const refreshedLabel = `${UNAVAILABLE_MODEL_LABEL} Refreshed`
  await injectInvalidLegacyModelForRejectionTest(control, refreshedLabel)
  const raw = await control.command('getLocalStorageItem', 'body', {
    value: LOCAL_MODEL_SETTINGS_STORAGE_KEY,
  })
  assert.equal(
    JSON.parse(raw).find(value => value.id === UNAVAILABLE_MODEL_ID)?.displayName,
    refreshedLabel
  )
  await control.command('waitFor', `[data-testid="harness-app-model-${INSTALLED_APP_ID}"]`, {
    text: MODEL_LABEL,
    timeoutMs: uiTimeoutMs,
  })
}
async function verifyStopDuringHeldLaunchResponse(
  control,
  {
    gates,
    ownedTabId,
    uiTimeoutMs,
    electronUserDataDirectory,
    instanceDirectory,
    resultDir,
    captureScreenshot,
  }
) {
  const id = 'closing-held-open'
  try {
    await armHostResponse(gates, id, 'smartApps.open')
    await selectOwnedAppsTab(control, ownedTabId, uiTimeoutMs)
    await control.command(
      'clickWhenEnabled',
      `[data-testid="harness-app-start-${INSTALLED_APP_ID}"]`,
      { timeoutMs: 60_000 }
    )
    await gates.wait(id, undefined, 600_000)
    const oldRoutes = await waitForActiveHarnessModelRoutes(instanceDirectory)
    assert.ok(
      oldRoutes.length > 1,
      'The held launch did not register default and additional routes'
    )
    const oldSurface = await workbenchState(control, INSTALLED_APP_ID)
    assert.equal(oldSurface.running, true)
    // The native Host owns routes. A delayed renderer response must not prevent stop.
    await invokeHost(control, 'smartApps.stop', { installationId: INSTALLED_APP_ID })
    await waitForReleasedRoutes(oldRoutes, 60_000)
    assert.equal((await workbenchState(control, INSTALLED_APP_ID)).running, false)
    // Open again before releasing the old response; the new Host lifetime is independent.
    const reopened = await invokeHost(control, 'smartApps.open', {
      installationId: INSTALLED_APP_ID,
    })
    const newRoutes = await waitForActiveHarnessModelRoutes(instanceDirectory)
    assert.ok(newRoutes.length > 1, 'Rapid reopen lost the additional model provider')
    for (const route of newRoutes)
      assert.equal(
        oldRoutes.some(old => old.baseUrl === route.baseUrl),
        false,
        'Rapid reopen reused a released route'
      )
    const newSurface = await workbenchState(control, INSTALLED_APP_ID)
    assert.notEqual(
      newSurface.contentsId,
      oldSurface.contentsId,
      'Stop retained the old renderer lifetime'
    )
    await gates.release(id)
    await control.command('waitFor', `[data-testid="harness-app-open-${INSTALLED_APP_ID}"]`, {
      enabled: true,
      timeoutMs: uiTimeoutMs,
    })
    const afterLateResponse = await workbenchState(control, INSTALLED_APP_ID)
    assertCurrentHarnessAppSurface(afterLateResponse, {
      contentsId: newSurface.contentsId,
      webUrl: reopened.webUrl,
    })
    const persisted = await waitForRunningInstallation(
      electronUserDataDirectory,
      INSTALLED_APP_ID,
      30_000
    )
    assert.equal(persisted.webUrl, reopened.webUrl)
    await waitForReleasedRoutes(oldRoutes, 60_000)
    await exerciseModelRoutes(control, reopened, {
      resultDir,
      screenshotName: 'harness-apps-15-rapid-reopen-model-routes.png',
      captureScreenshot,
    })
    await closeHarnessAppView(control, INSTALLED_APP_ID, uiTimeoutMs)
    await waitForReleasedRoutes(newRoutes, 60_000)
  } finally {
    await gates.save(resultDir, 'harness-model-held-open-response.json', [id])
    await gates.reset()
  }
}

export function assertCurrentHarnessAppSurface(actual, expected) {
  assert.equal(
    actual.contentsId,
    expected.contentsId,
    'A late response replaced the current Host surface'
  )
  assert.equal(
    new URL(actual.url).href,
    new URL(expected.webUrl).href,
    'A late response restored an obsolete runtime URL'
  )
}

async function workbenchState(control, installationId) {
  return JSON.parse(
    await control.command('workbenchApp', 'body', {
      value: JSON.stringify({ action: 'snapshot', id: installationId }),
    })
  )
}

async function closeHarnessAppView(control, installationId, uiTimeoutMs) {
  await control.command('workbenchApp', 'body', {
    value: JSON.stringify({ action: 'close', id: installationId }),
  })
  await waitForDshValue(
    () => workbenchState(control, installationId),
    value => !value.running,
    uiTimeoutMs
  )
}

async function startInstalledHarnessApp(
  control,
  installationId,
  { uiTimeoutMs, electronUserDataDirectory }
) {
  await openOwnedApps(control, uiTimeoutMs)
  await control.command('clickWhenEnabled', `[data-testid="harness-app-start-${installationId}"]`, {
    timeoutMs: 60_000,
  })
  await waitForDshValue(
    () => workbenchState(control, installationId),
    value => value.running && value.visible,
    600_000
  )
  return waitForRunningInstallation(electronUserDataDirectory, installationId, 30_000)
}

async function openOwnedApps(control, uiTimeoutMs) {
  await control.command('navigate', 'body', {
    value: '/sites?app_type=smart_app&view=owned',
  })
  await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="smart-apps-section-owned"]')
}

async function openSmartAppsTab(control, uiTimeoutMs) {
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-smart-app"]', {
    text: '工作台',
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="workspace-tab-add-smart-app"]')
  await control.command('waitFor', '[data-testid="smart-apps-owned-page"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="smart-apps-section-owned"]', {
    timeoutMs: uiTimeoutMs,
  })
}

async function selectHarnessAppModel(control, installationId, label, uiTimeoutMs) {
  const selector = `[data-testid="harness-app-model-${installationId}"]`
  await control.command('waitFor', selector, {
    text: label,
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

async function exerciseModelRoutes(
  control,
  installation,
  { resultDir, screenshotName, captureScreenshot }
) {
  const models = await dshRequest(control, installation.webUrl, 'session/modelCatalog', {})
  const defaultProvider = models.groups.find(group => group.id === 'wework-local')
  assert.ok(defaultProvider, 'DSH did not expose the original default model provider')
  assert.deepEqual(
    defaultProvider.models.map(model => model.id),
    ['wework-selected'],
    'The default provider no longer exposes the selected Wework model'
  )
  const extraProvider = models.groups.find(group => group.name === EXTRA_MODEL.labels[1])
  assert.ok(extraProvider, 'DSH did not load the extra Wework model provider')
  const extraModelId = extraProvider.models[0]?.id
  assert.ok(extraModelId, 'The extra Wework provider exposed no model')

  const workspace = join(resultDir, 'harness-app-models-workspace')
  await mkdir(workspace, { recursive: true })
  assert.deepEqual(
    { provider: models.default.provider, model: models.default.model },
    { provider: 'wework-local', model: 'wework-selected' },
    'The DSH catalog lost the original default model route'
  )
  const { sessionId } = await dshRequest(control, installation.webUrl, 'session/create', {
    request: { cwd: workspace },
  })

  const defaultPrompt = `HARNESS_DEFAULT_MODEL_PROMPT_${randomUUID()}`
  await dshRequest(control, installation.webUrl, 'session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: defaultPrompt }],
    },
  })
  await waitForHarnessModelRequest(control, defaultPrompt, DEFAULT_MODEL.modelId, 30_000)
  await waitForSessionIdle(control, installation.webUrl, sessionId, 30_000)
  await assertSessionModel(control, installation.webUrl, sessionId, {
    provider: 'wework-local',
    model: 'wework-selected',
  })

  await dshRequest(control, installation.webUrl, 'session/selectModel', {
    request: { sessionId, provider: extraProvider.id, model: extraModelId },
  })
  const extraPrompt = `HARNESS_EXTRA_MODEL_PROMPT_${randomUUID()}`
  await dshRequest(control, installation.webUrl, 'session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: extraPrompt }],
    },
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
  await waitForSessionIdle(control, installation.webUrl, sessionId, 30_000)
  await assertSessionModel(control, installation.webUrl, sessionId, {
    provider: extraProvider.id,
    model: extraModelId,
  })
  await captureScreenshot(control, screenshotName, 'body')
  return sessionId
}

async function readLocalModelConfigs(control) {
  const raw = await control.command('getNativeModelFixtureConfigs', 'body')
  const parsed = JSON.parse(raw)
  assert.ok(Array.isArray(parsed), 'Local model settings are not an array')
  return parsed
}

/** Keep one malformed historical record to verify rejection, never to configure normal models. */
async function injectInvalidLegacyModelForRejectionTest(
  control,
  displayName = UNAVAILABLE_MODEL_LABEL
) {
  await control.command('setLocalStorageItem', 'body', {
    value: JSON.stringify({
      key: LOCAL_MODEL_SETTINGS_STORAGE_KEY,
      value: JSON.stringify([
        {
          id: UNAVAILABLE_MODEL_ID,
          displayName,
          modelId: UNAVAILABLE_MODEL_UPSTREAM,
          // Native configuration correctly rejects this URL. A historical malformed
          // record must also never become an executable Smart app route.
          baseUrl: '',
          apiFormat: 'openai-chat-completions',
          requestPath: '/chat/completions',
          toolProfile: 'function',
          enabled: true,
          catalogReady: true,
          updatedAt: new Date().toISOString(),
        },
      ]),
    }),
  })
  await control.command('dispatchLocalModelSettingsChangedThenMacrotask', 'body')
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

async function waitForActiveHarnessModelRoutes(instanceDirectory) {
  // DSH imports startup settings into this profile before exposing its providers.
  return waitForDshValue(
    () => readActiveHarnessModelRoutes(instanceDirectory),
    routes => routes.length > 1,
    30_000
  )
}

async function dshRequest(control, baseUrl, method, payload) {
  const response = await fetchLocalRuntime(
    control,
    new URL(`api/${method}`, normalizeBaseUrl(baseUrl)),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method,
        payload: { args: payload },
      }),
      timeoutMs: 60_000,
    }
  )
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

async function waitForSessionIdle(control, baseUrl, sessionId, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const { items } = await dshRequest(control, baseUrl, 'session/list', { _request: {} })
    const session = items.find(item => item.sessionId === sessionId)
    if (session && !session.running) return
    await delay(100)
  }
  throw new Error(`DSH session ${sessionId} did not finish its turn`)
}

async function assertSessionModel(control, baseUrl, sessionId, expected) {
  const projections = await dshRequest(control, baseUrl, 'session/projections', {
    request: { sessionId },
  })
  const selection = projections?.values.modelSelection?.lastUsed
  assert.ok(selection, 'The DSH session did not persist its model selection')
  assert.deepEqual(
    { provider: selection.provider, model: selection.model },
    expected,
    'The DSH session did not persist the model route consumed by its request'
  )
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
  const instanceDirectory = join(userDataDirectory, 'harness-apps', 'instances', installationId)
  let routes = []
  while (Date.now() - startedAt < timeoutMs) {
    try {
      routes = await readPendingHarnessModelRoutes(instanceDirectory)
      if (routes.length > 1) break
    } catch {
      // The launch has not written its runtime settings yet.
    }
    await delay(100)
  }
  assert.ok(routes.length > 1, 'The failed launch never wrote its model routes')
  return routes
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
    `Harness model routes were not released: ${remaining
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
