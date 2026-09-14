import { waitForSnapshot } from './conversation-layout.mjs'

import {
  ensureExperimentalFeaturesDisabled,
  ensureExperimentalFeaturesEnabled,
} from './preferences-automation-flows.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  DEFAULT_STEP_TIMEOUT_MS,
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
const LOCAL_COLLABORATION_WORKSPACE_ID = 'wework-local-workspace'

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

async function enterLocalCollaborationWorkspace(control, contentSelector) {
  await waitForNativeCollaborationPlatform(control, contentSelector)
  const localWorkspaceTree = `${contentSelector} [data-testid="collaboration-workspace-tree-${LOCAL_COLLABORATION_WORKSPACE_ID}"]`
  const localWorkspaceIdentity = `${localWorkspaceTree} .collaboration-workspace-identity`
  await control.command('waitFor', localWorkspaceIdentity, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', localWorkspaceIdentity)
  const activeWorkspaceHome = `${localWorkspaceTree} [data-testid="collaboration-workspace-nav-projects"]`
  await control.command('waitFor', `${activeWorkspaceHome}[aria-current="page"]`, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${contentSelector} [data-testid="collaboration-workspace-project-create"]`,
    {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
}

async function createLocalCollaborationProject(control, contentSelector, projectName) {
  await enterLocalCollaborationWorkspace(control, contentSelector)
  await control.command(
    'click',
    `${contentSelector} [data-testid="collaboration-workspace-project-create"]`
  )
  const dialogSelector = `${contentSelector} [data-testid="collaboration-project-create-dialog"]`
  const nameSelector = `${dialogSelector} [data-testid="collaboration-project-name-input"]`
  const localLocationSelector = `${dialogSelector} [data-testid="cloud-project-location-local"]`
  await control.command('waitFor', dialogSelector, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', localLocationSelector, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.match(
    (await control.command('getAttribute', localLocationSelector, {
      value: 'class',
    })) ?? '',
    /collaboration-project-create-location-summary/,
    'The local project location was rendered as a switchable choice instead of a fixed summary'
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${dialogSelector} [data-testid="cloud-project-location-cloud"]`
      )
    ),
    0,
    'The local workspace project dialog exposed an invalid cloud location choice'
  )
  const localTaskProviderSelector = `${dialogSelector} [data-testid="cloud-project-task-provider-local"]`
  await control.command('waitFor', localTaskProviderSelector, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', localTaskProviderSelector, {
      value: 'aria-pressed',
    }),
    'true',
    'The local workspace project dialog did not default to its built-in task provider'
  )
  await control.command('fill', nameSelector, {
    value: projectName,
  })
  await control.command(
    'clickWhenEnabled',
    `${dialogSelector} [data-testid="collaboration-project-create-confirm"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command(
    'waitFor',
    `${contentSelector} [data-testid="cloud-project-header-title"]`,
    {
      text: projectName,
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
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
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
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
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
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

async function captureVerificationScreenshot(control, name, selector = 'body') {
  const screenshotMode = process.env.WEWORK_E2E_SCREENSHOTS
  if (screenshotMode === 'final' && !name.endsWith('04-task-completed-after-reopen.png')) {
    return null
  }
  if (screenshotMode === 'harness-milestones' && !HARNESS_MILESTONE_SCREENSHOTS.has(name)) {
    return null
  }
  const screenshotPath = join(resultDir, name)
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

async function verifyDefaultWorkspaceStartupTab(control) {
  await verifyWorkspaceTabsWithoutExperiments(control)
  await control.command('navigate', 'body', { value: '/settings' })
  await control.command('waitFor', '[data-testid="general-settings-page"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="general-fixed-tab-startup-fixed-board"]')
  await control.command(
    'waitFor',
    '[data-testid="general-fixed-tab-startup-fixed-board"][aria-pressed="true"]',
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await captureVerificationScreenshot(control, 'workspace-startup-tab-01-board-selected.png')

  await control.command('navigate', 'body', { value: '/' })
  await reloadMainWindow(
    control,
    'The Wework WebView did not reconnect after selecting Work items as the startup tab'
  )
  await control.command('waitFor', '[data-tab-kind="board"][aria-selected="true"]', {
    text: '协作',
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForNativeCollaborationPlatform(control, FIXED_BOARD_CONTENT_SELECTOR)
  await control.command('waitFor', FIXED_BOARD_CONTENT_SELECTOR, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-startup-tab-02-board-active.png')

  await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
  await control.command('waitFor', '[data-tab-kind="task"][aria-selected="true"]', {
    text: '任务',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('navigate', 'body', { value: '/settings' })
  await control.command('waitFor', '[data-testid="general-settings-page"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="general-fixed-tab-startup-fixed-task"]')
  await control.command(
    'waitFor',
    '[data-testid="general-fixed-tab-startup-fixed-task"][aria-pressed="true"]',
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('navigate', 'body', { value: '/' })
  await reloadMainWindow(
    control,
    'The Wework WebView did not reconnect after restoring Tasks as the startup tab'
  )
  await control.command('waitFor', '[data-tab-kind="task"][aria-selected="true"]', {
    text: '任务',
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-startup-tab-03-task-restored.png')
}

async function verifyWorkspaceIssueCreation(control) {
  await ensureExperimentalFeaturesEnabled(control)
  await control.command('waitFor', '[data-testid="workspace-tab-strip"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const existingBoardTabIds = workspaceTabIds(
    JSON.parse(await control.command('snapshot', 'body')),
    'board'
  )
  const { boardTabId, boardContentSelector } = await openProjectWorkspaceTab(
    control,
    existingBoardTabIds
  )

  const projectName = 'Workspace Issue E2E'
  const issueTitle =
    'WEWORK_DESKTOP_E2E_ISSUE_TITLE Verify that a deliberately long Issue title wraps across multiple lines in the workspace sidebar without clipping or overlapping the description below it.'
  const issueDescription =
    'WEWORK_DESKTOP_E2E_ISSUE Workspace fullscreen issue creation verified with a deliberately long description that spans more than two lines in the Issue sidebar so collapsed overflow treatment remains visible.'
  const twoLineIssueDescription = '折叠描述第一行\n折叠描述第二行'
  await createLocalCollaborationProject(control, boardContentSelector, projectName)

  const createIssueSelector = `${boardContentSelector} [data-testid="collaboration-issue-create"]`
  const createIssueDialog = `${boardContentSelector} [data-testid="collaboration-issue-create-dialog"]`
  const createIssuePanel = `${createIssueDialog} [data-testid="cloud-todo-create-panel"]`
  const createIssueTitle = `${createIssueDialog} [data-testid="cloud-todo-title"]`
  const createIssueDescription = `${createIssueDialog} [data-testid="cloud-todo-detail-description"]`
  await control.command('click', createIssueSelector)
  await control.command('waitFor', createIssuePanel, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', createIssueTitle, {
    value: issueTitle,
  })
  await control.command('fill', createIssueDescription, {
    value: issueDescription,
  })
  await captureVerificationScreenshot(control, 'workspace-issue-01-ready.png')
  await control.command('click', `${createIssueDialog} [data-testid="cloud-todo-modal-close"]`)
  await control.command('waitFor', createIssuePanel, {
    visible: false,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', createIssueSelector)
  await control.command('waitFor', createIssuePanel, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForControlValueIncludes(
    control,
    createIssueDescription,
    issueDescription,
    'Shared Issue description did not survive closing and reopening'
  )
  await waitForControlValueIncludes(
    control,
    createIssueTitle,
    issueTitle,
    'Shared Issue title did not survive closing and reopening'
  )
  await control.command(
    'clickWhenEnabled',
    `${createIssueDialog} [data-testid="cloud-todo-create-confirm"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const issueCardSelector = [
    `${boardContentSelector} button[data-testid^="cloud-todo-card-"]`,
    ':not([data-testid^="cloud-todo-card-task-"])',
    ':not([data-testid^="cloud-todo-card-more-"])',
    ':not([data-testid^="cloud-todo-card-archive-"])',
    ':not([data-testid^="cloud-todo-card-add-child-"])',
  ].join('')
  await control.command('markElementWithText', issueCardSelector, {
    text: issueTitle,
    value: 'workspace-created-issue',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const createdIssueCardSelector = `${boardContentSelector} [data-e2e-anchor-id="workspace-created-issue"]`
  const createdIssueTestId = await control.command('getAttribute', createdIssueCardSelector, {
    value: 'data-testid',
  })
  assert.match(
    createdIssueTestId ?? '',
    /^cloud-todo-card-.+$/,
    'The newly created Issue did not expose a stable board identity'
  )
  const createdIssueId = createdIssueTestId.slice('cloud-todo-card-'.length)
  const issueDetailSelector = `${boardContentSelector} [data-testid="collaboration-issue-detail"]`
  await control.command('waitFor', issueDetailSelector, {
    text: 'WEWORK_DESKTOP_E2E_ISSUE_TITLE',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const openedIssueDetailText = await control.command('getText', issueDetailSelector)
  assert.ok(
    openedIssueDetailText.includes(`${projectName} / ${createdIssueId}`),
    'The opened Issue detail was not bound to the newly created board card'
  )
  const [issueTitleMetrics] = JSON.parse(
    await control.command(
      'getElementMetrics',
      `${issueDetailSelector} [data-testid="cloud-todo-detail-title"]`
    )
  )
  const issueDetailDescription = `${issueDetailSelector} [data-testid="cloud-todo-detail-description"]`
  await waitForControlValueIncludes(
    control,
    issueDetailDescription,
    issueDescription,
    'The created Issue did not retain its shared description'
  )
  const issueTitleLineHeight = Number.parseFloat(
    await control.command(
      'getComputedStyleValue',
      `${issueDetailSelector} [data-testid="cloud-todo-detail-title"]`,
      { value: 'line-height' }
    )
  )
  assert.ok(
    issueTitleMetrics.scrollHeight >= issueTitleLineHeight * 2,
    `The Issue sidebar title fixture did not wrap across multiple lines: ${JSON.stringify({
      metrics: issueTitleMetrics,
      lineHeight: issueTitleLineHeight,
    })}`
  )
  assert.ok(
    issueTitleMetrics.clientHeight >= issueTitleMetrics.scrollHeight - 1,
    `The Issue sidebar title clipped wrapped content: ${JSON.stringify(issueTitleMetrics)}`
  )
  await captureVerificationScreenshot(
    control,
    'workspace-issue-02-created.png',
    boardContentSelector
  )
  const editIssueContentSelector = `${issueDetailSelector} [data-testid="cloud-todo-edit-content"]`
  await control.command('click', editIssueContentSelector)
  await waitForAttribute(
    control,
    issueDetailDescription,
    'contenteditable',
    'true',
    'The newly created Issue did not enter editable content mode'
  )
  await control.command('fill', issueDetailDescription, {
    value: twoLineIssueDescription,
  })
  await waitForControlValue(
    control,
    issueDetailDescription,
    twoLineIssueDescription,
    'The shared Issue editor did not preserve a two-line description'
  )
  const issueStatusSelector = `${boardContentSelector} [data-testid="cloud-todo-detail-status"]`
  await control.command('select', issueStatusSelector, { value: 'pending' })
  assert.equal(
    await control.command('getValue', issueStatusSelector),
    'pending',
    'The Issue did not enter pending before returning to its board'
  )
  await control.command(
    'clickWhenEnabled',
    `${boardContentSelector} [data-testid="cloud-todo-save"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command('waitFor', `${boardContentSelector} [data-testid="cloud-todo-save"]`, {
    visible: false,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(
    control,
    'workspace-issue-03-shared-detail-saved.png',
    boardContentSelector
  )
  await control.command('click', `${boardContentSelector} [data-testid="cloud-todo-detail-close"]`)
  await control.command(
    'waitFor',
    `${boardContentSelector} [data-testid="collaboration-issue-detail"]`,
    {
      visible: false,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await waitForNativeCollaborationPlatform(control, boardContentSelector, DEFAULT_STEP_TIMEOUT_MS)
  await control.command(
    'waitFor',
    `${boardContentSelector} [data-testid="cloud-todo-column-pending"]`,
    {
      text: 'WEWORK_DESKTOP_E2E_ISSUE',
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await captureVerificationScreenshot(
    control,
    'workspace-issue-04-on-board.png',
    boardContentSelector
  )
  await control.command('click', `[data-testid="workspace-tab-close-${boardTabId}"]`)
  await waitForSnapshot(
    control,
    snapshot =>
      workspaceTabIds(snapshot, 'board').length === existingBoardTabIds.length &&
      existingBoardTabIds.every(testId => snapshot.testIds.includes(testId)),
    'Closing the Issue creation project tab did not restore the fixed collaboration entry'
  )
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

async function requireActiveProjectBoardTab(control, message) {
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
  const activeBoardContentSelector = `[data-testid="workspace-tab-content-${activeBoardTabId}"]`
  await waitForNativeCollaborationPlatform(control, activeBoardContentSelector)
  return activeBoardContentSelector
}

async function verifyTrackedTaskBoardRunningStatus(
  control,
  screenshotName = 'workspace-02-running-task-synchronized.png'
) {
  await control.command('waitFor', '[data-testid="work-item-guide-summary-title"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="work-item-guide-summary-status"]', {
    text: '进行中',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="work-item-open-board-menu"]')
  const activeBoardContentSelector = await requireActiveProjectBoardTab(
    control,
    'The first work-item navigation did not open its project-space tab'
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
  await control.command('scrollIntoView', reviewColumnSelector)
  await control.command('waitFor', reviewColumnSelector, {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(
    control,
    'workspace-02a-running-task-stale-review.png',
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

async function verifyTrackedTaskSettledStatus(control) {
  await control.command('waitFor', '[data-testid="work-item-guide-summary-status"]', {
    text: '等待确认',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="work-item-open-board-menu"]')
  const activeBoardContentSelector = await requireActiveProjectBoardTab(
    control,
    'The settled work-item navigation did not open its project-space tab'
  )
  const runningColumnSelector = `${activeBoardContentSelector} [data-testid="cloud-todo-column-in_progress"]`
  const reviewColumnSelector = `${activeBoardContentSelector} [data-testid="cloud-todo-column-in_review"]`
  await control.command('scrollIntoView', reviewColumnSelector)
  await control.command('waitFor', reviewColumnSelector, {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.doesNotMatch(
    await control.command('getText', runningColumnSelector),
    /WEWORK_DESKTOP_E2E_TASK/,
    'The settled task remained in the running column'
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
  const activeBoardContentSelector = await requireActiveProjectBoardTab(
    control,
    'The default Issue context test did not open its project-space tab'
  )
  const boardCardSelector = [
    `${activeBoardContentSelector} button[data-testid^="cloud-todo-card-"]`,
    ':not([data-testid^="cloud-todo-card-task-"])',
    ':not([data-testid^="cloud-todo-card-more-"])',
    ':not([data-testid^="cloud-todo-card-archive-"])',
    ':not([data-testid^="cloud-todo-card-add-child-"])',
  ].join('')
  await control.command('clickElementWithText', boardCardSelector, {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const titleSelector = `${activeBoardContentSelector} [data-testid="cloud-todo-detail-title"]`
  await control.command('waitFor', titleSelector, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', titleSelector, { value: title })
  await control.command(
    'clickWhenEnabled',
    `${activeBoardContentSelector} [data-testid="cloud-todo-save"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
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
  await control.command('waitFor', '[data-testid="work-item-guide-summary-title"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="work-item-guide-summary-status"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-02-task-associated.png')
  await control.command('click', '[data-testid="work-item-open-details"]')
  await control.command(
    'waitFor',
    '[data-testid="right-workspace-panel-shell"][aria-hidden="false"] [data-testid="work-item-context-panel"]',
    {
      text: 'WEWORK_DESKTOP_E2E_TASK',
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await captureVerificationScreenshot(control, 'workspace-04-details-and-executions.png')
  await control.command('click', '[data-testid="work-item-open-board"]')
  const activeBoardContentSelector = await requireActiveProjectBoardTab(
    control,
    'The tracked work-item navigation did not open its project-space tab'
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
  const boardCardSelector = [
    `${activeBoardContentSelector} button[data-testid^="cloud-todo-card-"]`,
    ':not([data-testid^="cloud-todo-card-task-"])',
    ':not([data-testid^="cloud-todo-card-more-"])',
    ':not([data-testid^="cloud-todo-card-archive-"])',
    ':not([data-testid^="cloud-todo-card-add-child-"])',
  ].join('')
  await control.command('clickElementWithText', boardCardSelector, {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="cloud-todo-detail"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const activeTaskConversationSelector = `${activeBoardContentSelector} [data-testid^="cloud-todo-open-task-conversation-"]`
  await control.command(
    'click',
    `${activeBoardContentSelector} [data-testid="cloud-todo-toggle-tasks"]`
  )
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
  await waitForNativeCollaborationPlatform(
    control,
    activeBoardContentSelector,
    DEFAULT_STEP_TIMEOUT_MS
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
  const activeBoardContentSelector = await requireActiveProjectBoardTab(
    control,
    'The source work-item navigation did not open its project-space tab'
  )
  const targetProjectName = 'Existing Task Target Board'
  await createLocalCollaborationProject(control, activeBoardContentSelector, targetProjectName)
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
  await control.command('click', '[data-testid="work-item-change-board"]')
  await control.command('waitFor', '[data-testid="work-item-context-menu"]', {
    text: targetProjectName,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'markElementWithText',
    '[data-testid="work-item-context-menu"] [data-testid^="work-item-workspace-option-"]',
    {
      text: targetProjectName,
      value: 'existing-task-target-board',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command(
    'click',
    '[data-testid="work-item-context-menu"] [data-e2e-anchor-id="existing-task-target-board"]'
  )
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
  await control.command('click', '[data-testid="work-item-open-board-menu"]')
  const movedBoardContentSelector = await requireActiveProjectBoardTab(
    control,
    'The moved work-item navigation did not open its project-space tab'
  )
  await control.command(
    'waitFor',
    `${movedBoardContentSelector} [data-testid="cloud-project-header-title"]`,
    {
      text: targetProjectName,
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const movedReviewColumnSelector = `${movedBoardContentSelector} [data-testid="cloud-todo-column-in_review"]`
  await control.command('scrollIntoView', movedReviewColumnSelector)
  await control.command('waitFor', movedReviewColumnSelector, {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
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
  await control.command('click', '[data-testid="work-item-change-board"]')
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
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    actual = await control.command('getAttribute', selector, { value: name })
    if (actual === expected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${message}: expected ${name}=${expected}, received ${actual}`)
}

async function verifyWorkspaceTabIsolation(control) {
  await ensureExperimentalFeaturesEnabled(control)
  await control.command('waitFor', '[data-testid="workspace-tab-strip"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
  await control.command('waitFor', '[data-tab-kind="task"][aria-selected="true"]', {
    text: '任务',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await ensureExperimentalFeaturesEnabled(control)
  await control.command('waitFor', '[data-testid="workspace-tab-strip"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const initial = JSON.parse(await control.command('snapshot', 'body'))
  const initialTaskIds = workspaceTabIds(initial, 'task')
  const initialBoardIds = workspaceTabIds(initial, 'board')
  const initialAgentIds = workspaceTabIds(initial, 'agent')
  assert.equal(initialTaskIds.length, 1, 'The titlebar did not start with one task tab')
  assert.equal(initialBoardIds.length, 1, 'The titlebar did not start with one project-space tab')
  assert.equal(initialAgentIds.length, 1, 'The titlebar did not start with one Agent tab')
  assert.equal(
    initialTaskIds.length + initialBoardIds.length + initialAgentIds.length,
    3,
    'The titlebar did not start with exactly three product tabs'
  )
  await control.command('click', `[data-testid="${FIXED_BOARD_TAB_SELECT_TEST_ID}"]`)
  await waitForNativeCollaborationPlatform(control, FIXED_BOARD_CONTENT_SELECTOR)

  const firstTaskId = initialTaskIds[0].slice('workspace-tab-'.length)
  const firstTaskContent = `[data-testid="workspace-tab-content-${firstTaskId}"]`
  const firstTaskComposer = `${firstTaskContent} [data-testid="chat-message-input"]`
  await control.command('click', `[data-testid="workspace-tab-select-${firstTaskId}"]`)
  await control.command('waitFor', firstTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('fill', firstTaskComposer, { value: '第一个任务标签草稿' })

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-task"]')
  const withSecondTask = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'task').length === 2,
    'The explicit new-task action did not create a second task tab'
  )
  const secondTaskTestId = workspaceTabIds(withSecondTask, 'task').find(
    testId => !initialTaskIds.includes(testId)
  )
  assert.ok(secondTaskTestId, 'The second task tab identity was not observable')
  const secondTaskId = secondTaskTestId.slice('workspace-tab-'.length)
  const secondTaskContent = `[data-testid="workspace-tab-content-${secondTaskId}"]`
  const secondTaskComposer = `${secondTaskContent} [data-testid="chat-message-input"]`
  await control.command('waitFor', secondTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getValue', secondTaskComposer),
    '',
    'A new task tab inherited the first tab draft'
  )
  await control.command('fill', secondTaskComposer, { value: '第二个任务标签草稿' })
  await control.command('click', `[data-testid="workspace-tab-select-${firstTaskId}"]`)
  await control.command('waitFor', firstTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getValue', firstTaskComposer),
    '第一个任务标签草稿',
    'Editing the second task tab mutated or discarded the first task tab draft'
  )
  await control.command('click', `[data-testid="workspace-tab-select-${secondTaskId}"]`)
  await control.command('waitFor', secondTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getValue', secondTaskComposer),
    '第二个任务标签草稿',
    'Switching away from the second task tab lost its draft'
  )
  await control.command('click', `[data-testid="workspace-tab-select-${firstTaskId}"]`)
  await control.command('waitFor', firstTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-tabs-isolation-01-task-drafts.png')

  const {
    boardContentSelector: firstBoardContent,
    boardTabId: firstBoardId,
    boardTabTestId: firstBoardTestId,
  } = await openProjectWorkspaceTab(control, initialBoardIds)
  await enterLocalCollaborationWorkspace(control, firstBoardContent)
  const firstWorkspaceTree = `${firstBoardContent} [data-testid="collaboration-workspace-tree-${LOCAL_COLLABORATION_WORKSPACE_ID}"]`
  await control.command('hover', `${firstWorkspaceTree} .collaboration-workspace-row`)
  await control.command(
    'click',
    `${firstWorkspaceTree} [data-testid="collaboration-workspace-actions"]`
  )
  await control.command(
    'click',
    `${firstWorkspaceTree} [data-testid="collaboration-workspace-nav-settings"]`
  )
  await control.command(
    'waitFor',
    `${firstBoardContent} [data-testid="workspace-settings-shell"]`,
    {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const firstWorkspaceAgents = `${firstBoardContent} [data-testid="collaboration-workspace-nav-agents"]`
  await control.command('waitFor', firstWorkspaceAgents, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', firstWorkspaceAgents)
  await control.command('waitFor', `${firstWorkspaceAgents}[aria-current="page"]`, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const { boardContentSelector: secondBoardContent } = await openProjectWorkspaceTab(control, [
    ...initialBoardIds,
    firstBoardTestId,
  ])
  const secondLocalWorkspace = `${secondBoardContent} [data-testid="collaboration-workspace-home-${LOCAL_COLLABORATION_WORKSPACE_ID}"]`
  await control.command('waitFor', secondLocalWorkspace, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${secondBoardContent} [data-testid="workspace-settings-shell"]`
      )
    ),
    0,
    'A new project-space tab inherited the first tab workspace settings view'
  )
  assert.equal(
    await control.command('getAttribute', firstWorkspaceAgents, {
      value: 'aria-current',
    }),
    'page',
    'Opening a second project-space tab reset the first tab workspace section'
  )
  await enterLocalCollaborationWorkspace(control, secondBoardContent)
  const secondWorkspaceHome = `${secondBoardContent} [data-testid="collaboration-workspace-tree-${LOCAL_COLLABORATION_WORKSPACE_ID}"] [data-testid="collaboration-workspace-nav-projects"]`
  await waitForAttribute(
    control,
    secondWorkspaceHome,
    'aria-current',
    'page',
    'The second project-space tab did not enter the local workspace home independently'
  )
  await control.command('click', `[data-testid="workspace-tab-select-${firstBoardId}"]`)
  await control.command('waitFor', firstWorkspaceAgents, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForAttribute(
    control,
    firstWorkspaceAgents,
    'aria-current',
    'page',
    'Switching back did not restore the first project-space tab workspace section'
  )
  await captureVerificationScreenshot(control, 'workspace-tabs-isolation-02-project-spaces.png')

  await control.command('click', `[data-testid="workspace-tab-select-${firstTaskId}"]`)
  await control.command('waitFor', firstTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getValue', firstTaskComposer),
    '第一个任务标签草稿',
    'Switching through a project-space tab discarded the task draft'
  )
  await captureVerificationScreenshot(
    control,
    'workspace-tabs-isolation-02b-task-restored-after-project-space.png',
    firstTaskContent
  )

  const firstAgentId = initialAgentIds[0].slice('workspace-tab-'.length)
  const firstAgentContent = `[data-testid="workspace-tab-content-${firstAgentId}"]`
  const firstAgentWebview = `${firstAgentContent} [data-testid="app-iframe-wegent"]`
  await control.command('click', `[data-testid="workspace-tab-select-${firstAgentId}"]`)
  await control.command('waitFor', firstAgentWebview, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', firstAgentWebview, {
      value: 'data-workspace-tab-id',
    }),
    firstAgentId,
    'The first Agent webview was not bound to its tab identity'
  )
  const agentStorageKey = 'wework-e2e-agent-storage'
  const agentStorageValue = `persisted-${Date.now()}`
  await control.command('setEmbeddedBrowserLocalStorageItem', 'body', {
    value: JSON.stringify({
      key: agentStorageKey,
      label: `app-wegent-${firstAgentId}`,
      value: agentStorageValue,
    }),
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getEmbeddedBrowserLocalStorageItem', 'body', {
      value: JSON.stringify({
        key: agentStorageKey,
        label: `app-wegent-${firstAgentId}`,
      }),
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    }),
    agentStorageValue,
    'The first Agent webview did not retain its localStorage write'
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 3000))

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-agent"]')
  const withTemporaryAgent = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'agent').length === 2,
    'The explicit new-Agent action did not create an ordinary Agent tab'
  )
  const temporaryAgentTestId = workspaceTabIds(withTemporaryAgent, 'agent').find(
    testId => !initialAgentIds.includes(testId)
  )
  assert.ok(temporaryAgentTestId, 'The ordinary Agent tab identity was not observable')
  const temporaryAgentId = temporaryAgentTestId.slice('workspace-tab-'.length)
  await control.command('click', `[data-testid="workspace-tab-close-${temporaryAgentId}"]`)
  await waitForSnapshot(
    control,
    snapshot =>
      workspaceTabIds(snapshot, 'agent').length === 1 &&
      snapshot.testIds.includes(`workspace-tab-${firstAgentId}`),
    'Closing the ordinary Agent tab removed or replaced the fixed Agent tab'
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1500))

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-agent"]')
  const withSecondAgent = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'agent').length === 2,
    'The explicit new-Agent action did not reopen an Agent tab'
  )
  const secondAgentTestId = workspaceTabIds(withSecondAgent, 'agent').find(
    testId => !initialAgentIds.includes(testId)
  )
  assert.ok(secondAgentTestId, 'The second Agent tab identity was not observable')
  const secondAgentId = secondAgentTestId.slice('workspace-tab-'.length)
  const secondAgentContent = `[data-testid="workspace-tab-content-${secondAgentId}"]`
  const secondAgentWebview = `${secondAgentContent} [data-testid="app-iframe-wegent"]`
  await control.command('waitFor', secondAgentWebview, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', secondAgentWebview, {
      value: 'data-workspace-tab-id',
    }),
    secondAgentId,
    'The second Agent tab reused the first webview identity'
  )
  assert.equal(
    await control.command('getEmbeddedBrowserLocalStorageItem', 'body', {
      value: JSON.stringify({
        key: agentStorageKey,
        label: `app-wegent-${secondAgentId}`,
      }),
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    }),
    agentStorageValue,
    'Reopening Wegent did not restore its persisted localStorage'
  )

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-agent"]')
  const withThirdAgent = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'agent').length === 3,
    'The explicit new-Agent action did not create an independent Agent tab'
  )
  const thirdAgentTestId = workspaceTabIds(withThirdAgent, 'agent').find(
    testId => !initialAgentIds.includes(testId) && testId !== secondAgentTestId
  )
  assert.ok(thirdAgentTestId, 'The third Agent tab identity was not observable')
  const thirdAgentId = thirdAgentTestId.slice('workspace-tab-'.length)
  const thirdAgentContent = `[data-testid="workspace-tab-content-${thirdAgentId}"]`
  const thirdAgentWebview = `${thirdAgentContent} [data-testid="app-iframe-wegent"]`
  await control.command('waitFor', thirdAgentWebview, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', thirdAgentWebview, {
      value: 'data-workspace-tab-id',
    }),
    thirdAgentId,
    'The third Agent tab reused the reopened webview identity'
  )
  const agentSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    agentSnapshot.testIds.includes(`workspace-tab-content-${secondAgentId}`) &&
      agentSnapshot.testIds.includes(`workspace-tab-content-${thirdAgentId}`),
    'Switching Agent tabs unmounted one of the webview hosts'
  )
  await control.command('click', `[data-testid="workspace-tab-select-${secondAgentId}"]`)
  await control.command('waitFor', secondAgentWebview, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', thirdAgentWebview, {
      value: 'data-workspace-tab-id',
    }),
    thirdAgentId,
    'The hidden Agent webview host was recreated or detached after switching tabs'
  )
  await captureVerificationScreenshot(control, 'workspace-tabs-isolation-03-agent-webviews.png')

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-task"]')
  const withThirdTask = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'task').length === 3,
    'The route-isolation setup did not create a third task tab'
  )
  const thirdTaskTestId = workspaceTabIds(withThirdTask, 'task').find(
    testId => testId !== initialTaskIds[0] && testId !== secondTaskTestId
  )
  assert.ok(thirdTaskTestId, 'The third task tab identity was not observable')
  const thirdTaskId = thirdTaskTestId.slice('workspace-tab-'.length)
  const thirdTaskContent = `[data-testid="workspace-tab-content-${thirdTaskId}"]`

  await control.command('waitFor', `${thirdTaskContent} [data-testid="plugins-button"]`, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const thirdTaskSnapshot = JSON.parse(await control.command('snapshot', thirdTaskContent))
  assert.equal(
    thirdTaskSnapshot.testIds.includes('work-items-button'),
    false,
    'The task sidebar still exposed the removed Work items destination'
  )
  const tabCountBeforeOrdinaryNavigation = allWorkspaceTabIds(
    JSON.parse(await control.command('snapshot', '[data-testid="workspace-tab-strip-container"]'))
  ).length
  await control.command('click', `${thirdTaskContent} [data-testid="plugins-button"]`)
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const afterOrdinaryNavigation = JSON.parse(
    await control.command('snapshot', '[data-testid="workspace-tab-strip-container"]')
  )
  assert.equal(
    allWorkspaceTabIds(afterOrdinaryNavigation).length,
    tabCountBeforeOrdinaryNavigation,
    'Ordinary in-task navigation opened an extra document tab'
  )
  assert.ok(
    afterOrdinaryNavigation.testIds.includes(`workspace-tab-${thirdTaskId}`),
    'Ordinary navigation replaced the active tab identity instead of its content'
  )
  assert.equal(
    await control.command('getAttribute', `[data-testid="workspace-tab-select-${thirdTaskId}"]`, {
      value: 'data-tab-kind',
    }),
    'auxiliary',
    'Ordinary navigation did not replace the active tab kind in place'
  )

  const taskIdsBeforeFourth = workspaceTabIds(
    JSON.parse(await control.command('snapshot', 'body')),
    'task'
  )
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-task"]')
  const withFourthTask = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'task').length === taskIdsBeforeFourth.length + 1,
    'The route-isolation setup did not create a fourth task tab'
  )
  const fourthTaskTestId = workspaceTabIds(withFourthTask, 'task').find(
    testId => !taskIdsBeforeFourth.includes(testId)
  )
  assert.ok(fourthTaskTestId, 'The fourth task tab identity was not observable')
  const fourthTaskId = fourthTaskTestId.slice('workspace-tab-'.length)
  const fourthTaskContent = `[data-testid="workspace-tab-content-${fourthTaskId}"]`
  await control.command('waitFor', `${fourthTaskContent} [data-testid="automation-button"]`, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', `${fourthTaskContent} [data-testid="automation-button"]`)
  await control.command('waitFor', '[data-testid="create-automation-button"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="workspace-tab-select-${secondTaskId}"]`)
  await control.command('waitFor', `${secondTaskContent} [data-testid="chat-message-input"]`, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-tabs-isolation-04-route-replacement.png')

  await control.command('press', `[data-testid="workspace-tab-select-${secondTaskId}"]`, {
    key: 'Shift+F10',
  })
  await control.command('waitFor', '[data-testid="workspace-tab-context-menu"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const readyCountBeforeDetach = control.readyCount
  try {
    await control.command('click', '[data-testid="workspace-tab-open-new-window"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
  } catch (error) {
    if (!String(error).includes('replaced by a newer app session')) throw error
  }
  const detachedReady = await withTimeout(
    control.awaitReadyAfter(readyCountBeforeDetach),
    WORKBENCH_READY_TIMEOUT_MS,
    'The detached workspace window did not register its WebView'
  )
  assert.ok(
    detachedReady.windowLabel?.startsWith('workspace-'),
    `The detached tab registered an unexpected window: ${detachedReady.windowLabel}`
  )
  const detachedControl = {
    command: (...args) => control.commandForClient(detachedReady.clientId, ...args),
  }
  await detachedControl.command('waitFor', '[data-testid="workspace-tab-strip"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const detachedWindowSnapshot = JSON.parse(await detachedControl.command('snapshot', 'body'))
  assert.deepEqual(
    allWorkspaceTabIds(detachedWindowSnapshot),
    [`workspace-tab-${secondTaskId}`],
    'The detached window did not contain exactly the transferred task tab'
  )
  const detachedTaskComposer =
    `[data-testid="workspace-tab-content-${secondTaskId}"] ` + '[data-testid="chat-message-input"]'
  await detachedControl.command('waitFor', detachedTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await detachedControl.command('getValue', detachedTaskComposer),
    '第二个任务标签草稿',
    'Detaching the task tab lost its unsent draft'
  )
  await captureVerificationScreenshot(
    detachedControl,
    'workspace-tabs-isolation-05-detached-window.png',
    `[data-testid="workspace-tab-content-${secondTaskId}"]`
  )

  const sourceStorageKey = 'wework.workspaceTabs.v3:main'
  const sourceTabRemovalStartedAt = Date.now()
  let sourceTabs = []
  while (Date.now() - sourceTabRemovalStartedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const raw = await control.commandForWindow('main', 'getLocalStorageItem', 'body', {
      value: sourceStorageKey,
    })
    sourceTabs = raw ? (JSON.parse(raw).tabs ?? []) : []
    if (!sourceTabs.some(tab => tab.id === secondTaskId)) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.equal(
    sourceTabs.some(tab => tab.id === secondTaskId),
    false,
    'The transferred task tab remained open in the source window'
  )
  control.activateWindow('main')
}

export {
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
  verifyWorkspaceDocumentTabs,
  verifyDefaultWorkspaceStartupTab,
  verifyWorkspaceIssueCreation,
  verifyDefaultTaskBoardAssociation,
  verifyTrackedTaskBoardRunningStatus,
  verifyTrackedTaskRunningStatus,
  verifyTrackedTaskSettledStatus,
  enrichTrackedDefaultIssueTitle,
  verifyExistingTaskBoardAssociation,
  verifyExplicitlyTrackedTask,
  workspaceTabIds,
  openProjectWorkspaceTab,
  allWorkspaceTabIds,
  waitForAttribute,
  verifyWorkspaceTabIsolation,
}
