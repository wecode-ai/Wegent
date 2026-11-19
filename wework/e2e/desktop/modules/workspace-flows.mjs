import { requestExecutor } from './executor-rpc.mjs'
import {
  COLLABORATION_SIDEBAR_SELECTOR,
  inCollaborationSidebar,
  expandCollaborationSpaces,
  revealCollaborationSidebarElement,
} from './collaboration-sidebar-navigation.mjs'
export {
  COLLABORATION_SIDEBAR_SELECTOR,
  inCollaborationSidebar,
  expandCollaborationSpaces,
  revealCollaborationSidebarElement,
} from './collaboration-sidebar-navigation.mjs'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { waitForSnapshot } from './conversation-layout.mjs'
import {
  assertFullscreenIssueComposerColumn,
  assertFullscreenIssueComposerColumnAtWindowSize,
} from './issue-composer-layout.mjs'
import { verifyWorkspaceTabReturn } from './workspace-tab-return.mjs'
import {
  verifyNewTaskBoardAssociation,
  waitForViewedIssueRead,
} from './new-task-board-association.mjs'
import {
  waitForProjectIdentity,
  selectCollaborationProjectView,
  waitForLocalProjectNavigation,
} from './collaboration-project-navigation.mjs'
import { waitForClosedStartupSplash } from './native-window-state.mjs'

import {
  ensureExperimentalFeaturesDisabled,
  ensureExperimentalFeaturesEnabled,
} from './preferences-automation-flows.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_MODEL_ID,
  MODEL_PROVIDER_ID,
  TASK_PROMPT,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  resultDir,
  runChecked,
  withTimeout,
  writeFile,
} from './shared.mjs'

const FIXED_BOARD_ROUTE_TAB_ID = 'fixed-board'
const FIXED_BOARD_TAB_ID = `workspace-tab-${FIXED_BOARD_ROUTE_TAB_ID}`
const FIXED_BOARD_TAB_SELECT_TEST_ID = `workspace-tab-select-${FIXED_BOARD_ROUTE_TAB_ID}`
const FIXED_BOARD_TAB_CONTENT_TEST_ID = `workspace-tab-content-${FIXED_BOARD_ROUTE_TAB_ID}`
const FIXED_BOARD_CONTENT_SELECTOR = `[data-testid="${FIXED_BOARD_TAB_CONTENT_TEST_ID}"]`
const WEWORK_COLLABORATION_PLATFORM_TEST_ID = 'wework-collaboration-platform'
const SHARED_COLLABORATION_PLATFORM_TEST_ID = 'collaboration-platform-root'
export const LOCAL_COLLABORATION_WORKSPACE_ID = 'wework-local-workspace'
export function inProjectCreateDialog(selector = '') {
  const dialog = '[data-testid="collaboration-project-create-dialog"]'
  return selector ? `${dialog} ${selector}` : dialog
}

export async function openDirectProjectCreation(
  control,
  contentSelector,
  testId = 'collaboration-workspace-project-create'
) {
  const trigger = `${contentSelector} [data-testid="${testId}"]`
  await control.command('waitFor', trigger, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    Number(await control.command('getElementCount', `${trigger}[aria-haspopup]`)),
    0,
    'A single project creation method must be a direct action'
  )
  await control.command('click', trigger)
  await control.command('waitFor', inProjectCreateDialog(), {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    Number(await control.command('getElementCount', `[data-testid="${testId}-menu"]`)),
    0,
    'A single project creation method must not open an intermediate menu'
  )
}

export async function selectCollaborationDomain(control, contentSelector, domain) {
  assert.ok(domain === 'local' || domain === 'cloud', `Unknown collaboration domain: ${domain}`)
  await control.command(
    'waitFor',
    `${contentSelector} [data-testid="collaboration-platform-root"]`,
    {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${contentSelector} [data-testid="collaboration-domain-local"]`
      )
    ),
    0,
    'The unified collaboration board still exposed a local selector'
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${contentSelector} [data-testid="collaboration-domain-cloud"]`
      )
    ),
    0,
    'The unified collaboration board still exposed a cloud selector'
  )
  await expandCollaborationSpaces(control, contentSelector)
}

export async function selectCollaborationIssueAgent(
  control,
  triggerSelector,
  agentId,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  await control.command('click', triggerSelector)
  const option = `[data-testid="cloud-todo-detail-assignee-option-agent:${agentId}"]`
  await control.command('waitFor', option, { visible: true, timeoutMs })
  await control.command('click', option)
  await control.command('waitFor', `${triggerSelector}[data-value="agent:${agentId}"]`, {
    visible: true,
    timeoutMs,
  })
}

export async function waitForTestIdByText(
  control,
  contentSelector,
  prefix,
  expectedText,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const startedAt = Date.now()
  let lastTestIds = []
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', contentSelector))
    lastTestIds = snapshot.testIds.filter(testId => testId.startsWith(prefix))
    for (const testId of lastTestIds) {
      const selector = `[data-testid="${testId}"]`
      const text = await control.command('getText', selector)
      if (text.includes(expectedText)) return testId
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(
    `Unable to find test id ${prefix} containing ${JSON.stringify(expectedText)}: ${lastTestIds.join(
      ', '
    )}`
  )
}

export async function selectWhenOptionAvailable(control, selector, value, timeoutMs) {
  await control.command('waitFor', `${selector} option[value=${JSON.stringify(value)}]`, {
    timeoutMs,
  })
  await control.command('select', selector, { value })
}

export async function selectAgentEnvironment(
  control,
  testId,
  value,
  timeoutMs,
  verifyDefaultFilter = false,
  beforeSelect = () => {}
) {
  const trigger = `[data-testid="${testId}"]`
  await control.command('clickWhenEnabled', trigger, { timeoutMs })
  const search = `[data-testid="${testId}-search"]`
  await control.command('waitFor', search, { visible: true, timeoutMs })
  if (verifyDefaultFilter) {
    assert.equal(
      await control.command('getAttribute', `[data-testid="${testId}-menu"] [role="option"]`, {
        value: 'data-testid',
      }),
      `${testId}-option-policy:project_pool`,
      'Automatic selection must be the first environment option'
    )
    assert.equal(
      await control.command(
        'getAttribute',
        `[data-testid="${testId}-menu"] [role="listbox"] > div:nth-child(2) > [role="option"]`,
        { value: 'data-testid' }
      ),
      `${testId}-option-policy:user_select`,
      'Runtime selection must be the second environment option'
    )
    assert.equal(
      Number(
        await control.command('getElementCount', `[data-testid="${testId}-show-offline"]:checked`)
      ),
      0,
      'Execution environments must hide offline devices by default'
    )
  }
  const option = `[data-testid="${testId}-option-${value || 'empty'}"]`
  if (
    !value.startsWith('policy:') &&
    Number(await control.command('getElementCount', option)) === 0
  ) {
    await control.command('click', `[data-testid="${testId}-show-offline"]`)
  }
  await control.command('waitFor', option, { visible: true, timeoutMs })
  const label = await control.command('getText', option)
  await control.command('fill', search, { value: label })
  await beforeSelect()
  await control.command('clickWhenEnabled', option, { timeoutMs })
  await control.command('waitFor', `${trigger}[data-value=${JSON.stringify(value)}]`, { timeoutMs })
}

/** Native fixtures require an explicit environment; automatic routing is cloud-only. */
export async function selectProjectRunnerModel(control, timeoutMs) {
  const prefix = 'cloud-project-chat-agent'
  await setAgentRuntimeExpanded(control, 'cloud-project-chat-agent-editor', true, timeoutMs)
  const environment = `[data-testid="${prefix}-environment"]`
  const model = `[data-testid="${prefix}-model"]`
  const identity = JSON.stringify(['codex', MODEL_PROVIDER_ID, DEFAULT_MODEL_ID])
  await control.command('waitFor', `${environment}[data-value="policy:project_pool"]`, {
    timeoutMs,
  })
  await control.command('clickWhenEnabled', environment, { timeoutMs })
  const firstDevice = `[data-testid="${prefix}-environment-menu"] [role="option"]:not([data-testid$="policy:project_pool"]):not([data-testid$="policy:user_select"])`
  await control.command('waitFor', firstDevice, { visible: true, timeoutMs })
  const optionId = await control.command('getAttribute', firstDevice, { value: 'data-testid' })
  const environmentId = optionId.slice(`${prefix}-environment-option-`.length)
  assert.ok(environmentId, 'The isolated execution environment must be available')
  await control.command('clickWhenEnabled', firstDevice, { timeoutMs })
  await control.command('waitFor', `${model} option[value='${identity}']`, { timeoutMs })
  await selectWhenOptionAvailable(control, model, identity, timeoutMs)
  await selectAgentEnvironment(
    control,
    `${prefix}-environment`,
    'policy:project_pool',
    timeoutMs,
    true
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${model} option[value='${identity}']:not(:disabled)`
      )
    ),
    0,
    'Automatic environment routing must not expose native models'
  )
  await selectAgentEnvironment(control, `${prefix}-environment`, environmentId, timeoutMs)
  await control.command('waitFor', `${model} option[value='${identity}']`, { timeoutMs })
  await control.command('select', model, { value: 'user_select' })
  await control.command('waitFor', `${model} option[value="user_select"]:checked`, { timeoutMs })
  assert.equal(
    Number(
      await control.command('getElementCount', `${model} option[value="user_select"]:checked`)
    ),
    1,
    'The model selector must support choosing a model at run time'
  )
  await control.command('select', model, { value: identity })
  await control.command('waitFor', `[data-testid="${prefix}-model-sources"]`, { timeoutMs })
  assert.equal(
    Number(await control.command('getElementCount', `[data-testid="${prefix}-model-policy"]`)),
    0,
    'Agent creation must use one model selector without a separate policy field'
  )
  await setAgentRuntimeExpanded(control, 'cloud-project-chat-agent-editor', false, timeoutMs)
}

export async function setAgentRuntimeExpanded(control, dialogId, expanded, timeoutMs) {
  const selector = `[data-testid="${dialogId}-tab-runtime"]`
  const current = await control.command('getAttribute', selector, { value: 'aria-expanded' })
  assert.ok(
    current === 'true' || current === 'false',
    'Runtime settings must expose disclosure state'
  )
  if (current !== String(expanded))
    await control.command('clickWhenEnabled', selector, { timeoutMs })
  await control.command('waitFor', `${selector}[aria-expanded="${expanded}"]`, { timeoutMs })
}

/** Use a stable cloud resource identity and exercise the inline runtime disclosure. */
export async function selectCloudAgentModel(
  control,
  request,
  modelName,
  timeoutMs,
  environmentId = null
) {
  const dialog = 'wework-agent-resource-creator'
  await control.command('waitFor', `[data-testid="${dialog}-tab-runtime"][aria-expanded="false"]`, {
    timeoutMs,
  })
  const selector = '[data-testid="wework-agent-model"]'
  const modelOptions = `${selector} option:not([value=""]):not([value="user_select"]):not(:disabled)`
  await control.command('waitFor', `${modelOptions}:checked`, { timeoutMs })
  assert.equal(
    await control.command('getAttribute', `${modelOptions}:checked`, { value: 'value' }),
    await control.command('getAttribute', modelOptions, { value: 'value' }),
    'The first listed cloud model must be selected before opening runtime settings'
  )
  await control.command('waitFor', '[data-testid="wework-agent-resource-create"]:not(:disabled)', {
    timeoutMs,
  })
  await setAgentRuntimeExpanded(control, dialog, true, timeoutMs)
  await selectAgentEnvironment(
    control,
    'wework-agent-environment',
    environmentId === null ? 'policy:project_pool' : String(environmentId),
    timeoutMs,
    true
  )
  const models = await request(
    '/api/models/unified?include_config=false&scope=all&model_category_type=llm&client_origin=wework'
  )
  const model = models.data.find(item => item.name === modelName && item.type === 'public')
  assert.ok(model, `The cloud model ${modelName} must be available to the creating user`)
  const identity = JSON.stringify([
    'codex',
    'cloud',
    model.type,
    model.namespace,
    model.resourceUserId,
    model.name,
  ])
  await selectWhenOptionAvailable(control, selector, identity, timeoutMs)
  await setAgentRuntimeExpanded(control, dialog, false, timeoutMs)
  const summary = await control.command('getText', `[data-testid="${dialog}-runtime-summary"]`)
  assert.ok(
    summary.includes(model.displayName || model.name),
    'The collapsed runtime summary must show the selected model'
  )
}

export async function openProjectAgentCreator(
  control,
  addSelector,
  timeoutMs,
  editorTestId = 'cloud-project-chat-agent-editor'
) {
  await control.command('clickWhenEnabled', addSelector, { timeoutMs })
  const createMode = '[data-testid="project-agent-mode-create"]'
  await control.command('waitFor', createMode, { visible: true, timeoutMs })
  await control.command('click', createMode)
  await control.command('waitFor', `[data-testid="${editorTestId}"]`, {
    visible: true,
    timeoutMs,
  })
}

export async function configureFirstProjectExecutionEnvironment(
  control,
  contentSelector,
  timeoutMs,
  deviceId = null
) {
  await selectCollaborationProjectView(control, contentSelector, 'manage', timeoutMs)
  await control.command(
    'click',
    `${contentSelector} [data-testid="collaboration-project-settings-environments"]`
  )
  if (deviceId) {
    const pickerToggle = `${contentSelector} [data-testid="collaboration-project-execution-environment-add"]`
    const candidate = `${contentSelector} [data-testid="collaboration-project-execution-environment-candidate-${deviceId}"]`
    await control.command('click', pickerToggle)
    await control.command('waitFor', candidate, { visible: true, timeoutMs })
    await control.command('click', pickerToggle)
    await control.command('clickThenMacrotask', pickerToggle, {
      target: `${contentSelector} [data-testid="collaboration-project-execution-environment-picker"]`,
    })
    assert.equal(
      Number(await control.command('getElementCount', candidate)),
      1,
      'Reopening the device picker discarded the loaded candidate'
    )
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${contentSelector} [data-testid="collaboration-project-execution-environment-picker-loading"]`
        )
      ),
      0,
      'Reopening the device picker replaced candidates with a loading placeholder'
    )
    await control.command('clickWhenEnabled', candidate, { timeoutMs })
    await control.command(
      'waitFor',
      `${contentSelector} [data-testid="collaboration-project-execution-environment-${deviceId}"]`,
      { visible: true, timeoutMs }
    )
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${contentSelector} [data-testid="collaboration-project-execution-environments-error"]`
        )
      ),
      0,
      'The selected device was not authorized for the project'
    )
  }
  await control.command(
    'waitFor',
    `${contentSelector} [data-testid="collaboration-project-execution-environment-environments"]`,
    { text: '在线', timeoutMs }
  )
  await control.command(
    'click',
    `${contentSelector} [data-testid="collaboration-project-settings-project"]`
  )
  // Reopening must expose cached runners and an enabled picker before refresh completes.
  await control.command(
    'clickThenMacrotask',
    `${contentSelector} [data-testid="collaboration-project-settings-environments"]`,
    { target: `${contentSelector} [data-testid="collaboration-project-execution-environment-add"]` }
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${contentSelector} [data-testid="collaboration-project-execution-environment-loading"]`
      )
    ),
    0,
    'Reopening execution environments replaced the cached devices with a loading placeholder'
  )
  assert.match(
    await control.command(
      'getText',
      `${contentSelector} [data-testid="collaboration-project-execution-environment-environments"]`
    ),
    /在线/,
    'Reopening execution environments lost the configured device'
  )
  await control.command(
    'click',
    `${contentSelector} [data-testid="collaboration-project-execution-environment-add"]`
  )
}

async function waitForNativeCollaborationPlatform(
  control,
  contentSelector,
  timeoutMs = WORKBENCH_READY_TIMEOUT_MS
) {
  const weworkPlatformSelector = `${contentSelector} [data-testid="${WEWORK_COLLABORATION_PLATFORM_TEST_ID}"]`
  await control.command('waitFor', weworkPlatformSelector, {
    visible: true,
    timeoutMs,
  })
  await control.command(
    'waitFor',
    `${weworkPlatformSelector} [data-testid="${SHARED_COLLABORATION_PLATFORM_TEST_ID}"]`,
    {
      visible: true,
      timeoutMs,
    }
  )
  const platformSnapshot = JSON.parse(await control.command('snapshot', contentSelector))
  assert.ok(
    platformSnapshot.testIds.includes(WEWORK_COLLABORATION_PLATFORM_TEST_ID) &&
      platformSnapshot.testIds.includes(SHARED_COLLABORATION_PLATFORM_TEST_ID),
    'The project-space tab did not render the native shared collaboration module'
  )
  assert.equal(
    platformSnapshot.testIds.includes('cloud-todo-workspace'),
    false,
    'The project-space tab rendered the retired CloudTodoWorkspace'
  )
  assert.equal(
    platformSnapshot.testIds.some(testId => testId.startsWith('app-iframe-')),
    false,
    'The native collaboration module was wrapped in an iframe'
  )
  return weworkPlatformSelector
}

export async function enterLocalCollaborationWorkspace(control, contentSelector) {
  await waitForNativeCollaborationPlatform(control, contentSelector)
  await expandCollaborationSpaces(control, contentSelector)
  const localIdentity = inCollaborationSidebar(
    '[data-testid="collaboration-workspace-tree-wework-local-workspace"] .collaboration-workspace-identity',
    contentSelector
  )
  await revealCollaborationSidebarElement(control, localIdentity, WORKBENCH_READY_TIMEOUT_MS)
  await control.command('clickWhenEnabled', localIdentity)
  const group = inCollaborationSidebar(
    '[data-testid="collaboration-project-tree"] > .collaboration-workspace-group:first-child',
    contentSelector
  )
  const toggle = `${group} .collaboration-workspace-toggle`
  if (
    Number(await control.command('getElementCount', toggle)) > 0 &&
    (await control.command('getAttribute', toggle, { value: 'aria-expanded' })) === 'false'
  )
    await control.command('click', toggle)
}

/** Seed an existing offline project through production Native APIs; project-first-navigation covers creation UI. */
export async function createLocalCollaborationProject(control, contentSelector, projectName) {
  const workspacePath = join(
    resultDir,
    'local-collaboration-projects',
    projectName.replace(/[^\p{L}\p{N}._-]+/gu, '-')
  )
  await mkdir(workspacePath, { recursive: true })
  await runChecked('git', ['init', workspacePath])
  const projectKey = randomUUID()
  await requestExecutor(
    control,
    'runtime.projects.upsert_local',
    { projectKey, name: projectName, roots: [workspacePath], runtime: 'codex' },
    DEFAULT_STEP_TIMEOUT_MS
  )
  const project = await requestExecutor(
    control,
    'projects.import_code_project',
    { project_key: projectKey, name: projectName, roots: [workspacePath] },
    DEFAULT_STEP_TIMEOUT_MS
  )
  await reloadMainWindow(control, 'The existing offline project did not appear after native import')
  await waitForNativeCollaborationPlatform(control, contentSelector)
  const selector = inCollaborationSidebar(
    `[data-testid="collaboration-workspace-project-${project.id}"]`,
    contentSelector
  )
  await revealCollaborationSidebarElement(control, selector)
  await control.command('click', selector)
  await waitForLocalProjectNavigation(control, contentSelector, projectName)
}

export async function completeLocalCollaborationFolderImport(control, projectName) {
  const workspacePath = join(
    resultDir,
    'local-collaboration-projects',
    projectName.replace(/[^\p{L}\p{N}._-]+/gu, '-')
  )
  await mkdir(workspacePath, { recursive: true })
  // The evidence directory lives under the Wegent checkout. Give the imported
  // folder its own repository boundary so product discovery does not mistake
  // the parent checkout for the project's configured source repository.
  await runChecked('git', ['init', workspacePath])
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForFolderPickerInitialized(control)
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForFolderPathReady(control, workspacePath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: projectName,
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', {
    visible: false,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function waitForFolderPathReady(control, expectedPath) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const inputValue = await control.command('getValue', '[data-testid="device-folder-path-input"]')
    const directoryText = await control.command(
      'getText',
      '[data-testid="device-folder-directory-list"]'
    )
    if (inputValue === expectedPath && !/Loading directories|正在加载目录/.test(directoryText)) {
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`The device folder picker did not finish loading ${expectedPath}`)
}

async function waitForFolderPickerInitialized(control) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const inputValue = await control.command('getValue', '[data-testid="device-folder-path-input"]')
    const directoryText = await control.command(
      'getText',
      '[data-testid="device-folder-directory-list"]'
    )
    if (inputValue.length > 0 && !/Loading directories|正在加载目录/.test(directoryText)) {
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('The device folder picker did not finish loading its initial path')
}

async function waitForControlValue(
  control,
  selector,
  expected,
  message,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  // A click can resolve before React mounts the control being polled.
  await control.command('waitFor', selector, { timeoutMs })
  const startedAt = Date.now()
  let lastValue = ''
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await control.command('getValue', selector)
    if (lastValue === expected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(
    `${message}: expected=${JSON.stringify(expected)}, received=${JSON.stringify(lastValue)}`
  )
}

function normalizeComposerText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function waitForControlValueIncludes(
  control,
  selector,
  expectedSubstring,
  message,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const expected = normalizeComposerText(expectedSubstring)
  const startedAt = Date.now()
  let lastValue = ''
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await control.command('getValue', selector)
    if (normalizeComposerText(lastValue).includes(expected)) return lastValue
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${message}: ${JSON.stringify(lastValue)}`)
}

async function waitForControlSelectionOffset(control, selector, expected, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    if (Number(await control.command('getSelectionOffset', selector)) === expected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function waitForPersistedComposerInput(control, expected, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(
      await control.command('getWorkbenchDebugSnapshot', 'body', { value: 'state-only' })
    )
    if (snapshot.workbench?.composer?.currentInputLength === expected.length) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function waitForWorkbenchTask(control, taskId, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    if (snapshot.workbench?.currentRuntimeTask?.taskId === taskId) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

function currentRuntimeTaskFromDebugSnapshot(snapshot) {
  return snapshot?.workbench?.currentRuntimeTask ?? snapshot?.pane?.currentRuntimeTask ?? null
}

async function waitForWorkbenchDebugState(
  control,
  predicate,
  message,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const startedAt = Date.now()
  let lastSnapshot = null
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(
      await control.command('getWorkbenchDebugSnapshot', 'body', { value: 'state-only' })
    )
    lastSnapshot = snapshot
    if (predicate(snapshot)) return snapshot
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${message}: ${JSON.stringify(lastSnapshot)}`)
}

async function waitForStableSnapshot(control, predicate, message) {
  const startedAt = Date.now()
  let stableSince = null
  let lastSnapshot = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    lastSnapshot = snapshot
    if (predicate(snapshot)) {
      stableSince ??= Date.now()
      if (Date.now() - stableSince >= 500) return snapshot
    } else {
      stableSince = null
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${message}: ${JSON.stringify(lastSnapshot)}`)
}

const HARNESS_MILESTONE_SCREENSHOTS = new Set([
  'harness-apps-03-marketplace.png',
  'harness-apps-03a-official-running.png',
  'harness-apps-03b4-plugin-reloaded.png',
  'harness-apps-04a-publish-dialog-zh.png',
  'harness-apps-08-native-page.png',
  'harness-apps-08a-workbench-loaded.png',
  'harness-apps-08b-workbench-add-menu.png',
  'harness-apps-08c-workbench-context-menu.png',
  'harness-apps-09-running.png',
  'harness-apps-15-returned-to-marketplace.png',
  'harness-apps-16-experimental-disabled.png',
])

async function captureVerificationScreenshot(control, name, selector = 'body', options = {}) {
  const conversationDiagnostics = await control.command(
    'getConversationDiagnosticsSnapshot',
    'body'
  )
  if (conversationDiagnostics !== 'null') {
    await writeFile(
      join(resultDir, `${name}.conversation-diagnostics.json`),
      `${conversationDiagnostics}\n`,
      'utf8'
    )
  }
  const screenshotMode = process.env.WEWORK_E2E_SCREENSHOTS
  const requiredAppearanceEvidence = name.startsWith('appearance-')
  if (
    !requiredAppearanceEvidence &&
    screenshotMode === 'final' &&
    !name.endsWith('04-task-completed-after-reopen.png')
  ) {
    return null
  }
  if (
    !requiredAppearanceEvidence &&
    screenshotMode === 'harness-milestones' &&
    !HARNESS_MILESTONE_SCREENSHOTS.has(name)
  ) {
    return null
  }
  const screenshotPath = join(resultDir, name)
  if (options.surface === 'primary-view') {
    const png = await capturePrimaryVerificationScreenshot(control, selector)
    await writeFile(screenshotPath, png)
    return screenshotPath
  }
  if (process.platform === 'linux') {
    await runChecked('import', ['-window', 'root', screenshotPath])
    return screenshotPath
  }
  let dataUrl
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      dataUrl = await control.command('capture', selector, { timeoutMs: 90_000 })
      break
    } catch (error) {
      if (attempt === 2) throw error
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
    }
  }
  const prefix = 'data:image/png;base64,'
  assert.ok(dataUrl.startsWith(prefix), 'Desktop screenshot did not return PNG data')
  await writeFile(screenshotPath, Buffer.from(dataUrl.slice(prefix.length), 'base64'))
  return screenshotPath
}

async function capturePrimaryVerificationScreenshot(control, selector) {
  const [metrics] = JSON.parse(await control.command('getElementMetrics', selector))
  assert.ok(metrics, `Primary-view screenshot selector is unavailable: ${selector}`)
  const width = selector === 'body' ? metrics.viewportWidth : metrics.width
  const height = selector === 'body' ? metrics.viewportHeight : metrics.height
  assert.ok(width > 0 && height > 0, 'Primary-view screenshots require a visible rectangle')
  const dataUrl = await control.command('capture', selector, { timeoutMs: 90_000 })
  const prefix = 'data:image/png;base64,'
  assert.ok(dataUrl.startsWith(prefix), 'Primary-view screenshot did not return PNG data')
  const png = Buffer.from(dataUrl.slice(prefix.length), 'base64')
  assert.ok(
    png.length >= 24 &&
      png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      png.toString('ascii', 12, 16) === 'IHDR',
    'Primary-view screenshot has no valid PNG dimensions'
  )
  const actual = [png.readUInt32BE(16), png.readUInt32BE(20)]
  // The existing host may return CSS pixels or device pixels; both axes must share one scale.
  const scales = [1, metrics.devicePixelRatio].filter(scale => Number.isFinite(scale) && scale > 0)
  assert.ok(
    scales.some(
      scale => actual[0] === Math.round(width * scale) && actual[1] === Math.round(height * scale)
    ),
    `Primary-view PNG ${actual.join('x')} does not match ${selector} ${width}x${height}`
  )
  return png
}

async function verifyWorkspaceDocumentTabs(control) {
  await ensureExperimentalFeaturesEnabled(control)
  await control.command('waitFor', '[data-testid="workspace-tab-strip"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-tab-kind="task"][aria-selected="true"]', {
    text: '任务',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const initialBoardTabIds = workspaceTabIds(initialSnapshot, 'board')

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="workspace-tab-add-board"]')
  const openedSnapshot = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'board').length === initialBoardTabIds.length + 1,
    'Adding a project-space document tab did not create a distinct tab'
  )
  const addedBoardTabId = workspaceTabIds(openedSnapshot, 'board').find(
    testId => !initialBoardTabIds.includes(testId)
  )
  assert.ok(addedBoardTabId, 'The newly added project-space tab could not be identified')
  const addedBoardTabSuffix = addedBoardTabId.slice('workspace-tab-board-'.length)
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-select-board-${addedBoardTabSuffix}"][aria-selected="true"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await waitForNativeCollaborationPlatform(
    control,
    `[data-testid="workspace-tab-content-board-${addedBoardTabSuffix}"]`,
    DEFAULT_STEP_TIMEOUT_MS
  )
  await captureVerificationScreenshot(control, 'workspace-tabs-01-project-spaces-active.png')

  const initialTaskTabId = workspaceTabIds(initialSnapshot, 'task')[0]?.slice(
    'workspace-tab-'.length
  )
  assert.ok(initialTaskTabId, 'The initial task tab could not be identified')
  await control.command('click', `[data-testid="workspace-tab-select-${initialTaskTabId}"]`)
  await control.command('waitFor', '[data-tab-kind="task"][aria-selected="true"]', {
    text: '任务',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="workspace-tab-close-board-${addedBoardTabSuffix}"]`)
  await waitForSnapshot(
    control,
    snapshot => {
      const boardTabIds = workspaceTabIds(snapshot, 'board')
      return (
        !boardTabIds.includes(addedBoardTabId) &&
        initialBoardTabIds.every(testId => boardTabIds.includes(testId))
      )
    },
    'Closing the added project-space document tab did not preserve the original tabs'
  )
  await captureVerificationScreenshot(control, 'workspace-tabs-02-task-restored.png')
}

async function reloadMainWindow(control, errorMessage) {
  // Reloading during the native handoff invalidates its pending compositor capture.
  await waitForClosedStartupSplash(control)
  const readyCountBeforeReload = control.readyCount
  await control.command('reloadMainWindow', 'body')
  await withTimeout(
    control.awaitReadyAfter(readyCountBeforeReload),
    WORKBENCH_READY_TIMEOUT_MS,
    errorMessage
  )
}

async function verifyWorkspaceTabsWithoutExperiments(control) {
  await ensureExperimentalFeaturesDisabled(control)
  await control.command('waitFor', '[data-testid="workspace-tab-strip"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const tabStripSnapshot = JSON.parse(
    await control.command('snapshot', '[data-testid="workspace-tab-strip"]')
  )
  assert.ok(
    workspaceTabIds(tabStripSnapshot, 'task').length > 0,
    'Disabling experiments removed the task tab'
  )
  assert.ok(
    workspaceTabIds(tabStripSnapshot, 'agent').length > 0,
    'Disabling experiments removed the Agent tab'
  )
  assert.ok(
    workspaceTabIds(tabStripSnapshot, 'board').length > 0,
    'Disabling experiments removed the project-space tab'
  )

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const addMenuSnapshot = JSON.parse(
    await control.command('snapshot', '[data-testid="workspace-tab-add-menu"]')
  )
  assert.ok(
    addMenuSnapshot.testIds.includes('workspace-tab-add-task'),
    'The new-tab menu removed task creation while experiments were disabled'
  )
  assert.ok(
    addMenuSnapshot.testIds.includes('workspace-tab-add-agent'),
    'The new-tab menu removed Agent creation while experiments were disabled'
  )
  assert.ok(
    addMenuSnapshot.testIds.includes('workspace-tab-add-board'),
    'Disabling experiments removed project-space creation from the new-tab menu'
  )
  await captureVerificationScreenshot(control, 'workspace-tabs-00-experiments-disabled.png')
  await control.command('click', '[data-testid="workspace-tab-add"]')
}

async function verifyDefaultTaskBoardAssociation(control) {
  await ensureExperimentalFeaturesDisabled(control)
  try {
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    await control.command('navigate', 'body', { value: '/' })
    await reloadMainWindow(
      control,
      'The Wework WebView did not reconnect before the first project-space navigation'
    )
    await control.command(
      'waitFor',
      '[data-testid="workspace-tab-select-fixed-task"][aria-selected="true"]',
      { timeoutMs: WORKBENCH_READY_TIMEOUT_MS }
    )
    const startupTabs = JSON.parse(
      await control.command('snapshot', '[data-testid="workspace-tab-strip"]')
    )
    assert.deepEqual(
      workspaceTabIds(startupTabs, 'board'),
      [FIXED_BOARD_TAB_ID],
      'The fresh task workspace did not start with one unresolved fixed project-space tab'
    )
    await control.command('markElementWithText', '[data-testid^="project-row-"]', {
      text: 'workspace',
      value: 'default-association-project',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const refreshedProjectRowSelector = '[data-e2e-anchor-id="default-association-project"]'
    await control.command('hover', refreshedProjectRowSelector, { visible: true })
    await control.command(
      'click',
      `${refreshedProjectRowSelector} [data-testid="project-new-conversation-button"]`
    )
    await control.command('waitFor', '[data-testid="project-work-button"]', {
      text: 'workspace',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const taskTabTestId = await control.command(
      'getAttribute',
      '[data-tab-kind="task"][aria-selected="true"]',
      { value: 'data-testid' }
    )
    assert.ok(
      taskTabTestId,
      'The active task tab identity was unavailable before association setup'
    )

    await control.command('waitFor', '[data-testid="project-space-context-pill"]', {
      text: '我的任务',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(control, 'workspace-01-new-task.png')
    return taskTabTestId
  } finally {
    await ensureExperimentalFeaturesEnabled(control)
  }
}

async function activeOrdinaryBoardContentSelector(control, message) {
  await control.command('waitFor', '[data-tab-kind="board"][aria-selected="true"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const activeBoardTabTestId = await control.command(
    'getAttribute',
    '[data-tab-kind="board"][aria-selected="true"]',
    { value: 'data-testid' }
  )
  assert.ok(
    activeBoardTabTestId?.startsWith('workspace-tab-select-board-'),
    `${message}: ${activeBoardTabTestId}`
  )
  const activeBoardTabId = activeBoardTabTestId.slice('workspace-tab-select-'.length)
  return `[data-testid="workspace-tab-content-${activeBoardTabId}"]`
}

async function requireActiveWorkItemsTab(control, message) {
  const activeBoardContentSelector = await activeOrdinaryBoardContentSelector(control, message)
  await control.command(
    'waitFor',
    `${activeBoardContentSelector} [data-testid="cloud-todo-workspace"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  const location = new URL(snapshot.location)
  assert.equal(
    location.searchParams.get('projectId'),
    'default-work-items',
    `${message}: the opened board did not target My Tasks`
  )
  return activeBoardContentSelector
}

async function requireActiveCollaborationTab(control, message, { fixed = false } = {}) {
  await control.command('waitFor', '[data-tab-kind="board"][aria-selected="true"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const activeBoardTabTestId = await control.command(
    'getAttribute',
    '[data-tab-kind="board"][aria-selected="true"]',
    { value: 'data-testid' }
  )
  const expectedPrefix = fixed ? 'workspace-tab-select-fixed-board' : 'workspace-tab-select-board-'
  assert.ok(activeBoardTabTestId?.startsWith(expectedPrefix), `${message}: ${activeBoardTabTestId}`)
  const activeBoardTabId = activeBoardTabTestId.slice('workspace-tab-select-'.length)
  const activeBoardContentSelector = `[data-testid="workspace-tab-content-${activeBoardTabId}"]`
  await waitForNativeCollaborationPlatform(control, activeBoardContentSelector)
  return activeBoardContentSelector
}

async function waitForStableColumnPlacement(
  control,
  includedColumnSelector,
  excludedColumnSelector,
  text,
  message
) {
  const startedAt = Date.now()
  let stableSince = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const includedText = await control.command('getText', includedColumnSelector)
    const excludedText = await control.command('getText', excludedColumnSelector)
    if (includedText.includes(text) && !excludedText.includes(text)) {
      stableSince ??= Date.now()
      if (Date.now() - stableSince >= 500) return
    } else {
      stableSince = null
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function verifyTrackedTaskBoardRunningStatus(
  control,
  screenshotName = 'workspace-02-running-task-synchronized.png'
) {
  await control.command('waitFor', '[data-testid="work-item-guide-summary-title"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="work-item-open-board-menu"]')
  const activeBoardContentSelector = await requireActiveWorkItemsTab(
    control,
    'The first work-item navigation did not open its My Tasks tab'
  )
  const runningColumnSelector = `${activeBoardContentSelector} [data-testid="cloud-todo-column-in_progress"]`
  const reviewColumnSelector = `${activeBoardContentSelector} [data-testid="cloud-todo-column-in_review"]`
  await control.command('waitFor', runningColumnSelector, {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.doesNotMatch(
    await control.command('getText', reviewColumnSelector),
    /WEWORK_DESKTOP_E2E_TASK/,
    'The running task was also rendered in the review column'
  )
  if (screenshotName) {
    await captureVerificationScreenshot(control, screenshotName, activeBoardContentSelector)
  }
  return {
    activeBoardContentSelector,
    reviewColumnSelector,
    runningColumnSelector,
  }
}

async function verifyTrackedTaskRunningStatus(control, taskTabTestId) {
  const { activeBoardContentSelector, reviewColumnSelector, runningColumnSelector } =
    await verifyTrackedTaskBoardRunningStatus(control)
  const boardCardSelector = [
    `${activeBoardContentSelector} button[data-testid^="cloud-todo-card-"]`,
    ':not([data-testid^="cloud-todo-card-task-"])',
    ':not([data-testid^="cloud-todo-card-more-"])',
    ':not([data-testid^="cloud-todo-card-archive-"])',
    ':not([data-testid^="cloud-todo-card-add-child-"])',
  ].join('')
  await control.command('markElementWithText', boardCardSelector, {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    value: 'running-work-item-card',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'dragDataTransfer',
    `${activeBoardContentSelector} [data-e2e-anchor-id="running-work-item-card"]`,
    {
      target: `${activeBoardContentSelector} [data-testid="cloud-todo-column-dropzone-in_review"]`,
    }
  )
  await waitForStableColumnPlacement(
    control,
    runningColumnSelector,
    reviewColumnSelector,
    'WEWORK_DESKTOP_E2E_TASK',
    'The active runtime task did not remain in progress after a conflicting board move'
  )
  await captureVerificationScreenshot(
    control,
    'workspace-02a-running-task-authoritative.png',
    activeBoardContentSelector
  )

  await reloadMainWindow(
    control,
    'The Wework WebView did not reconnect while restoring a running My Tasks Issue'
  )
  await control.command('waitFor', '[data-tab-kind="board"][aria-selected="true"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', runningColumnSelector, {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.doesNotMatch(
    await control.command('getText', reviewColumnSelector),
    /WEWORK_DESKTOP_E2E_TASK/,
    'Reloading left the active task Issue in the review column'
  )

  await control.command('click', `[data-testid="${taskTabTestId}"]`)
  await control.command('waitFor', `[data-testid="${taskTabTestId}"][aria-selected="true"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-user"]', {
    text: TASK_PROMPT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="pause-response-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function openBoardTaskPageByText(control, activeBoardContentSelector, text, marker) {
  const boardCardId = await control.command(
    'markElementWithText',
    `${activeBoardContentSelector} [data-testid^="cloud-todo-card-drop-"]`,
    {
      text,
      value: marker,
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  assert.ok(boardCardId.startsWith('cloud-todo-card-drop-'))
  const boardItemId = boardCardId.slice('cloud-todo-card-drop-'.length)
  const boardCardSelector = `${activeBoardContentSelector} [data-testid="${boardCardId}"]`
  const openTaskSelector = `${boardCardSelector} [data-testid="cloud-todo-card-open-task-${boardItemId}"]`
  const selector =
    Number(await control.command('getElementCount', openTaskSelector)) > 0
      ? openTaskSelector
      : `${boardCardSelector} [data-testid="cloud-todo-card-${boardItemId}"]`
  await control.command('scrollIntoView', selector)
  await control.command('click', selector, { visible: true })
  await control.command(
    'waitFor',
    `${activeBoardContentSelector} [data-testid="cloud-todo-detail"]`,
    {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
}

async function enrichTrackedDefaultIssueTitle(control, taskTabTestId, title) {
  await control.command('click', `[data-testid="${taskTabTestId}"]`)
  await control.command('waitFor', '[data-testid="work-item-guide-summary-title"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="work-item-open-board-menu"]')
  const activeBoardContentSelector = await requireActiveWorkItemsTab(
    control,
    'The default Issue context test did not open its My Tasks tab'
  )
  await openBoardTaskPageByText(
    control,
    activeBoardContentSelector,
    'WEWORK_DESKTOP_E2E_TASK',
    'enrich-default-issue-board-card'
  )
  const titleSelector = `${activeBoardContentSelector} [data-testid="cloud-todo-detail-title"]`
  await control.command('waitFor', titleSelector, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', titleSelector)
  await control.command('fill', titleSelector, { value: title })
  await control.command('press', titleSelector, { key: 'Enter' })
  await control.command(
    'waitFor',
    `${activeBoardContentSelector} [data-testid="cloud-todo-save"]`,
    {
      visible: false,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command('click', `[data-testid="${taskTabTestId}"]`)
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifyExplicitlyTrackedTask(control, taskTabTestId) {
  const issuePanel =
    '[data-testid="right-workspace-panel-shell"][aria-hidden="false"] [data-testid="work-item-context-panel"]'
  const comment = '从任务页 Issue 详情发送的动态在协作页保持一致'
  await control.command('waitFor', '[data-testid="work-item-guide-summary-title"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-02-task-associated.png')
  await control.command('click', '[data-testid="work-item-open-details"]')
  await control.command('waitFor', issuePanel, {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const activityComposer = `${issuePanel} [data-testid="cloud-task-activity-composer"]`
  await control.command('waitFor', activityComposer)
  await control.command('scrollIntoView', activityComposer)
  await control.command('waitFor', activityComposer, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', activityComposer, { value: comment })
  await control.command(
    'clickWhenEnabled',
    `${issuePanel} [data-testid="task-comment-form"] [data-testid="send-message-button"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', `${issuePanel} [data-testid="cloud-task-activity-list"]`, {
    text: comment,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-04-details-and-executions.png')
  await control.command('click', '[data-testid="work-item-open-board"]')
  const activeBoardContentSelector = await requireActiveWorkItemsTab(
    control,
    'The tracked work-item navigation did not open its My Tasks tab'
  )
  await waitForStableSnapshot(
    control,
    snapshot =>
      !snapshot.location.includes('itemId=') &&
      !snapshot.testIds.includes('cloud-todo-board-loading') &&
      snapshot.text.includes('WEWORK_DESKTOP_E2E_TASK'),
    'The work-item board did not settle on the tracked task awaiting confirmation'
  )
  const reviewColumnSelector = `${activeBoardContentSelector} [data-testid="cloud-todo-column-in_review"]`
  await control.command('scrollIntoView', reviewColumnSelector)
  await control.command('waitFor', reviewColumnSelector, {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(
    control,
    'workspace-05-awaiting-confirmation-on-board.png',
    activeBoardContentSelector
  )
  await openBoardTaskPageByText(
    control,
    activeBoardContentSelector,
    'WEWORK_DESKTOP_E2E_TASK',
    'tracked-task-board-card'
  )
  await control.command('waitFor', '[data-testid="cloud-todo-detail"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${activeBoardContentSelector} [data-testid="cloud-task-activity-list"]`,
    { text: comment, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  const activeTaskConversationSelector = `${activeBoardContentSelector} [data-testid^="cloud-todo-open-task-conversation-"]`
  await control.command('waitFor', activeTaskConversationSelector, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', activeTaskConversationSelector, {
    visible: true,
  })
  await control.command('waitFor', '[data-testid="ai-chat-modal"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="work-item-task-chat-panel"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(
    control,
    'workspace-06-task-quick-conversation.png',
    activeBoardContentSelector
  )
  await control.command('click', '[data-testid="ai-chat-modal-close"]', {
    visible: true,
  })
  await control.command(
    'waitFor',
    `${activeBoardContentSelector} [data-testid="cloud-todo-workspace"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await captureVerificationScreenshot(
    control,
    'workspace-07-independent-tab.png',
    activeBoardContentSelector
  )
  await verifyExistingTaskBoardAssociation(control, taskTabTestId)
}

async function verifyExistingTaskBoardAssociation(
  control,
  taskTabTestId,
  { captureScreenshots = true } = {}
) {
  await control.command('click', `[data-testid="${taskTabTestId}"]`)
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="work-item-guide-summary-title"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="work-item-open-board-menu"]')
  await requireActiveWorkItemsTab(
    control,
    'The source work-item navigation did not open its My Tasks tab'
  )
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  const activeBoardContentSelector = await requireActiveCollaborationTab(
    control,
    'The fixed collaboration tab did not open the collaboration platform',
    { fixed: true }
  )
  const targetProjectName = `Existing Task Target Board ${randomUUID().slice(0, 8)}`
  await createLocalCollaborationProject(control, activeBoardContentSelector, targetProjectName)
  await configureFirstProjectExecutionEnvironment(
    control,
    activeBoardContentSelector,
    DEFAULT_STEP_TIMEOUT_MS
  )
  await selectCollaborationProjectView(control, activeBoardContentSelector, 'board')
  await control.command(
    'waitFor',
    `${activeBoardContentSelector} [data-testid="collaboration-issue-create"]`,
    {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const existingTargetTitle = 'WEWORK_EXISTING_BOARD_CARD'
  const createIssueSelector = `${activeBoardContentSelector} [data-testid="collaboration-issue-create"]`
  const createIssueDialog = `${activeBoardContentSelector} [data-testid="collaboration-issue-create-dialog"]`
  const createIssuePanel = `${createIssueDialog} [data-testid="cloud-todo-create-panel"]`
  await control.command('click', createIssueSelector)
  await control.command('waitFor', createIssuePanel, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', `${createIssueDialog} [data-testid="cloud-todo-title"]`, {
    value: existingTargetTitle,
  })
  await control.command(
    'clickWhenEnabled',
    `${createIssueDialog} [data-testid="cloud-todo-create-confirm"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command(
    'waitFor',
    `${activeBoardContentSelector} [data-testid="collaboration-issue-detail"]`,
    {
      text: existingTargetTitle,
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )

  await control.command('click', `[data-testid="${taskTabTestId}"]`)
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="work-item-change-board"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="work-item-change-board"]')
  await control.command('waitFor', '[data-testid="work-item-context-menu"]', {
    text: targetProjectName,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const pickerSearch = '[data-testid="project-space-picker-search"]'
  await control.command('fill', pickerSearch, { value: 'NO_SUCH_PROJECT_PRJBA8FC1_42' })
  await control.command('waitFor', '[data-testid="project-space-picker-empty"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        '[data-testid="work-item-context-menu"] [role="option"]'
      )
    ),
    0,
    'Searching for an unknown project must not leave unrelated options selectable'
  )
  await control.command('waitFor', '[data-testid="clear-project-space-context-button"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="project-space-picker-clear-search"]')
  await control.command('fill', pickerSearch, { value: targetProjectName })
  await control.command('waitFor', '[data-testid="work-item-context-menu"] [role="option"]', {
    text: targetProjectName,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const targetOption = '[data-testid="work-item-context-menu"] [role="option"]'
  assert.equal(
    Number(await control.command('getElementCount', targetOption)),
    1,
    'Searching for the unique test project must produce exactly one selectable result'
  )
  await control.command('press', pickerSearch, { key: 'Escape' })
  await control.command('waitFor', '[data-testid="work-item-context-menu"]', {
    visible: false,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="work-item-change-board"]')
  await control.command('fill', pickerSearch, { value: targetProjectName })
  await control.command('waitFor', '[data-testid="work-item-context-menu"] [role="option"]', {
    text: targetProjectName,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('press', pickerSearch, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="task-board-association-dialog"]', {
    text: targetProjectName,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  if (captureScreenshots) {
    await captureVerificationScreenshot(control, 'workspace-08-existing-task-add-dialog.png')
  }
  await control.command('click', '[data-testid="task-board-association-create"]')
  await control.command('waitFor', '[data-testid="task-board-move-confirm"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="task-board-move-confirm"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="task-board-association-dialog"]', {
    visible: false,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="work-item-guide-summary-title"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="work-item-change-board"]')
  await control.command('waitFor', '[data-testid="work-item-context-menu"]', {
    text: targetProjectName,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="work-item-open-board-menu"]')
  const movedBoardContentSelector = await requireActiveCollaborationTab(
    control,
    'The moved work-item navigation did not open its project-space tab'
  )
  await waitForProjectIdentity(
    control,
    movedBoardContentSelector,
    targetProjectName,
    DEFAULT_STEP_TIMEOUT_MS
  )
  const movedBoardSelector = `${movedBoardContentSelector} [data-testid="collaboration-board"]`
  await control.command('waitFor', movedBoardSelector, {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${movedBoardContentSelector} [data-testid="collaboration-issue-detail"]`,
    {
      text: 'WEWORK_DESKTOP_E2E_TASK',
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="work-item-context-menu"]')),
    0,
    'Opening the linked Issue board must unmount the project-space picker'
  )
  if (captureScreenshots) {
    await captureVerificationScreenshot(
      control,
      'workspace-09-existing-task-moved.png',
      movedBoardContentSelector
    )
  }
  await control.command('click', `[data-testid="${taskTabTestId}"]`)
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="work-item-change-board"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="work-item-change-board"]')
  await control.command(
    'markElementWithText',
    '[data-testid="work-item-context-menu"] [data-testid^="work-item-workspace-option-"]',
    {
      text: targetProjectName,
      value: 'existing-task-current-board',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command(
    'click',
    '[data-testid="work-item-context-menu"] [data-e2e-anchor-id="existing-task-current-board"]'
  )
  await control.command('waitFor', '[data-testid="task-board-association-search"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="task-board-association-search"]', {
    value: existingTargetTitle,
  })
  await control.command(
    'waitFor',
    '[data-testid="task-board-association-dialog"] [data-testid^="task-board-association-item-"]',
    {
      text: existingTargetTitle,
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command(
    'click',
    '[data-testid="task-board-association-dialog"] [data-testid^="task-board-association-item-"]',
    {
      visible: true,
    }
  )
  await control.command('waitFor', '[data-testid="work-item-guide-summary-title"]', {
    text: existingTargetTitle,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  if (captureScreenshots) {
    await captureVerificationScreenshot(control, 'workspace-10-existing-card-linked.png')
  }
  await control.command('click', '[data-testid="work-item-guide-open-summary"]')
  const linkedDetail = '[data-testid="work-item-context-panel"]'
  await control.command('waitFor', linkedDetail, {
    text: existingTargetTitle,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('cloud-task-activity-list') &&
      !snapshot.text.includes('正在加载动态'),
    'The newly associated Issue activity did not finish loading',
    DEFAULT_STEP_TIMEOUT_MS,
    linkedDetail
  )
  // The final association displays a different Issue; finish its read before the draft baseline.
  await waitForViewedIssueRead(control, targetProjectName, existingTargetTitle)
  await verifyNewTaskBoardAssociation(control, targetProjectName, existingTargetTitle)
  await control.command('click', `[data-testid="${taskTabTestId}"]`)
}

function workspaceTabIds(snapshot, kind) {
  return snapshot.testIds.filter(
    testId =>
      testId === `workspace-tab-fixed-${kind}` || testId.startsWith(`workspace-tab-${kind}-`)
  )
}

function allWorkspaceTabIds(snapshot) {
  return ['task', 'board', 'agent', 'auxiliary'].flatMap(kind => workspaceTabIds(snapshot, kind))
}

async function openProjectWorkspaceTab(control, existingBoardTabIds) {
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="workspace-tab-add-board"]')
  const openedSnapshot = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'board').length === existingBoardTabIds.length + 1,
    'Adding a project-space tab did not create a distinct tab'
  )
  const boardTabTestId = workspaceTabIds(openedSnapshot, 'board').find(
    testId => !existingBoardTabIds.includes(testId)
  )
  assert.ok(boardTabTestId, 'The newly added project-space tab could not be identified')
  const boardTabId = boardTabTestId.slice('workspace-tab-'.length)
  const boardTabSelector = `[data-testid="workspace-tab-select-${boardTabId}"]`
  const boardContentSelector = `[data-testid="workspace-tab-content-${boardTabId}"]`
  await control.command('waitFor', `${boardTabSelector}[aria-selected="true"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForNativeCollaborationPlatform(control, boardContentSelector)
  return {
    boardContentSelector,
    boardTabId,
    boardTabTestId,
  }
}

async function waitForAttribute(control, selector, name, expected, message) {
  const startedAt = Date.now()
  let actual = null
  let lookupError = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    try {
      actual = await control.command('getAttribute', selector, { value: name })
      lookupError = null
    } catch (error) {
      if (!String(error).includes('Unable to find selector')) throw error
      lookupError = error
    }
    if (actual === expected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  const received = lookupError ? String(lookupError) : actual
  throw new Error(`${message}: expected ${name}=${expected}, received ${received}`)
}

export {
  selectCollaborationProjectView,
  waitForFolderPathReady,
  waitForFolderPickerInitialized,
  waitForControlValue,
  normalizeComposerText,
  waitForControlValueIncludes,
  waitForControlSelectionOffset,
  waitForPersistedComposerInput,
  waitForWorkbenchTask,
  currentRuntimeTaskFromDebugSnapshot,
  waitForWorkbenchDebugState,
  captureVerificationScreenshot,
  reloadMainWindow,
  waitForNativeCollaborationPlatform,
  verifyWorkspaceDocumentTabs,
  verifyDefaultTaskBoardAssociation,
  verifyTrackedTaskBoardRunningStatus,
  verifyTrackedTaskRunningStatus,
  enrichTrackedDefaultIssueTitle,
  verifyExistingTaskBoardAssociation,
  verifyExplicitlyTrackedTask,
  workspaceTabIds,
  openProjectWorkspaceTab,
  allWorkspaceTabIds,
  waitForAttribute,
}
