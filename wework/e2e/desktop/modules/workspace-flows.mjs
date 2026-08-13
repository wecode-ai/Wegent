import { waitForSnapshot } from './conversation-layout.mjs'

import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  DEFAULT_STEP_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  resultDir,
  runChecked,
  withTimeout,
  writeFile,
} from './shared.mjs'

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
  while (Date.now() - startedAt < timeoutMs) {
    if ((await control.command('getValue', selector)) === expected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
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

async function waitForWorkbenchDebugState(control, predicate, message) {
  const startedAt = Date.now()
  let lastSnapshot = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    lastSnapshot = snapshot
    if (predicate(snapshot)) return snapshot
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${message}: ${JSON.stringify(lastSnapshot)}`)
}

async function captureVerificationScreenshot(control, name, selector = 'body') {
  if (
    process.env.WEWORK_E2E_SCREENSHOTS === 'final' &&
    !name.endsWith('04-task-completed-after-reopen.png')
  ) {
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
  await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-tabs-01-project-spaces-active.png')

  await control.command('click', '[data-testid^="workspace-tab-select-task-"]')
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

async function verifyDefaultWorkspaceStartupTab(control) {
  await control.command('navigate', 'body', { value: '/settings' })
  await control.command('waitFor', '[data-testid="general-settings-page"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command(
    'clickWhenEnabled',
    '[data-testid="general-default-workspace-tab-board-button"]'
  )
  await control.command(
    'waitFor',
    '[data-testid="general-default-workspace-tab-board-button"][aria-pressed="true"]',
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await captureVerificationScreenshot(control, 'workspace-startup-tab-01-board-selected.png')

  await control.command('navigate', 'body', { value: '/' })
  await reloadMainWindow(
    control,
    'The Wework WebView did not reconnect after selecting Project space as the startup tab'
  )
  await control.command('waitFor', '[data-tab-kind="board"][aria-selected="true"]', {
    text: '项目空间',
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-startup-tab-02-board-active.png')

  await control.command('click', '[data-testid^="workspace-tab-select-task-"]')
  await control.command('waitFor', '[data-tab-kind="task"][aria-selected="true"]', {
    text: '任务',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('navigate', 'body', { value: '/settings' })
  await control.command('waitFor', '[data-testid="general-settings-page"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command(
    'clickWhenEnabled',
    '[data-testid="general-default-workspace-tab-task-button"]'
  )
  await control.command(
    'waitFor',
    '[data-testid="general-default-workspace-tab-task-button"][aria-pressed="true"]',
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

async function configureDefaultProjectSpaceAssociation(control, localProjectId) {
  await ensureExperimentalFeaturesEnabled(control)
  const taskTabTestId = await control.command(
    'getAttribute',
    '[data-tab-kind="task"][aria-selected="true"]',
    { value: 'data-testid' }
  )
  assert.ok(taskTabTestId, 'The active task tab identity was unavailable before association setup')

  await control.command('click', '[data-testid^="workspace-tab-select-board-"]')
  await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const boardSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const createSelector = boardSnapshot.testIds.includes('cloud-projects-home-create')
    ? '[data-testid="cloud-projects-home-create"]'
    : '[data-testid="cloud-project-add"]'
  await control.command('click', createSelector)
  await control.command('waitFor', '[data-testid="cloud-project-name"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="cloud-project-name"]', {
    value: 'Task Follow-up Board',
  })
  await control.command('click', '[data-testid="cloud-project-location-local"]')
  await control.command('click', '[data-testid="cloud-project-task-provider-local"]')
  await control.command('clickWhenEnabled', '[data-testid="cloud-project-create-confirm"]')
  await control.command('waitFor', '[data-testid="cloud-project-manage-view"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'project-space-created-for-local-project.png')
  await control.command('click', `[data-testid="${taskTabTestId}"]`)
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="project-menu-${localProjectId}"]`)
  await control.command('click', `[data-testid="edit-project-${localProjectId}"]`)
  await control.command('waitFor', '[data-testid="local-project-edit-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('select', '[data-testid="local-project-auto-join-space-select"]', {
    by: 'label',
    value: 'Task Follow-up Board',
  })
  await control.command('clickWhenEnabled', '[data-testid="save-local-project-button"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('local-project-edit-dialog'),
    'Saving the local project did not close the edit dialog',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await control.command('waitFor', '[data-testid="project-space-context-pill"]', {
    text: 'Task Follow-up Board',
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="add-context-button"]')
  await control.command('waitFor', '[data-testid="add-project-space-context-button"]', {
    text: 'Task Follow-up Board',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="add-project-space-context-button"]')
  await control.command('waitFor', '[data-testid^="add-context-cloud-project-space-"]', {
    text: 'Task Follow-up Board',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('press', 'body', { key: 'Escape' })
  return taskTabTestId
}

async function verifyExplicitlyTrackedTask(control, taskTabTestId) {
  await control.command('click', '[data-testid^="workspace-tab-select-board-"]')
  await control.command('waitFor', '[data-testid="cloud-project-board-view"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="cloud-project-board-view"]')
  await control.command('waitFor', '[data-testid="cloud-todo-column-in_review"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'project-space-selected-task-in-review.png')
  await control.command('click', `[data-testid="${taskTabTestId}"]`)
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

function workspaceTabIds(snapshot, kind) {
  return snapshot.testIds.filter(testId => testId.startsWith(`workspace-tab-${kind}-`))
}

function allWorkspaceTabIds(snapshot) {
  return ['task', 'board', 'agent', 'auxiliary'].flatMap(kind => workspaceTabIds(snapshot, kind))
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

  const firstBoardId = initialBoardIds[0].slice('workspace-tab-'.length)
  const firstBoardContent = `[data-testid="workspace-tab-content-${firstBoardId}"]`
  const firstBoardWorkspace = `${firstBoardContent} [data-testid="cloud-todo-workspace"]`
  await control.command('click', `[data-testid="workspace-tab-select-${firstBoardId}"]`)
  await control.command('waitFor', firstBoardWorkspace, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForAttribute(
    control,
    firstBoardWorkspace,
    'data-sidebar-collapsed',
    'false',
    'The first project-space tab did not start expanded'
  )
  await control.command('click', `${firstBoardContent} [data-testid="cloud-todo-collapse-sidebar"]`)
  await waitForAttribute(
    control,
    firstBoardWorkspace,
    'data-sidebar-collapsed',
    'true',
    'The first project-space tab did not preserve its local sidebar state'
  )

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-board"]')
  const withSecondBoard = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'board').length === 2,
    'The explicit new-project-space action did not create a second tab'
  )
  const secondBoardTestId = workspaceTabIds(withSecondBoard, 'board').find(
    testId => !initialBoardIds.includes(testId)
  )
  assert.ok(secondBoardTestId, 'The second project-space tab identity was not observable')
  const secondBoardId = secondBoardTestId.slice('workspace-tab-'.length)
  const secondBoardContent = `[data-testid="workspace-tab-content-${secondBoardId}"]`
  const secondBoardWorkspace = `${secondBoardContent} [data-testid="cloud-todo-workspace"]`
  await control.command('waitFor', secondBoardWorkspace, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForAttribute(
    control,
    secondBoardWorkspace,
    'data-sidebar-collapsed',
    'false',
    'A new project-space tab inherited the first tab sidebar state'
  )
  assert.equal(
    await control.command('getAttribute', firstBoardWorkspace, {
      value: 'data-sidebar-collapsed',
    }),
    'true',
    'Opening a second project-space tab reset the first tab state'
  )
  await control.command('click', `[data-testid="workspace-tab-select-${firstBoardId}"]`)
  await control.command('waitFor', firstBoardWorkspace, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForAttribute(
    control,
    firstBoardWorkspace,
    'data-sidebar-collapsed',
    'true',
    'Switching back did not restore the first project-space tab state'
  )
  await captureVerificationScreenshot(control, 'workspace-tabs-isolation-02-project-spaces.png')

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
  await control.command('click', `[data-testid="workspace-tab-close-${firstAgentId}"]`)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(`workspace-tab-${firstAgentId}`),
    'Closing the first Agent tab did not remove its webview host'
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1500))

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-agent"]')
  const withSecondAgent = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'agent').length === 1,
    'The explicit new-Agent action did not reopen an Agent tab'
  )
  const secondAgentTestId = workspaceTabIds(withSecondAgent, 'agent')[0]
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
    snapshot => workspaceTabIds(snapshot, 'agent').length === 2,
    'The explicit new-Agent action did not create an independent Agent tab'
  )
  const thirdAgentTestId = workspaceTabIds(withThirdAgent, 'agent').find(
    testId => testId !== secondAgentTestId
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

  await control.command('click', `[data-testid="workspace-tab-select-${firstTaskId}"]`)
  await control.command('waitFor', `${firstTaskContent} [data-testid="plugins-button"]`, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const tabCountBeforeOrdinaryNavigation = allWorkspaceTabIds(
    JSON.parse(await control.command('snapshot', 'body'))
  ).length
  await control.command('click', `${firstTaskContent} [data-testid="plugins-button"]`)
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const afterOrdinaryNavigation = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    allWorkspaceTabIds(afterOrdinaryNavigation).length,
    tabCountBeforeOrdinaryNavigation,
    'Ordinary in-task navigation opened an extra document tab'
  )
  assert.ok(
    afterOrdinaryNavigation.testIds.includes(`workspace-tab-${firstTaskId}`),
    'Ordinary navigation replaced the active tab identity instead of its content'
  )
  assert.equal(
    await control.command('getAttribute', `[data-testid="workspace-tab-select-${firstTaskId}"]`, {
      value: 'data-tab-kind',
    }),
    'auxiliary',
    'Ordinary navigation did not replace the active tab kind in place'
  )
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
    'workspace-tabs-isolation-05-detached-window.png'
  )

  const sourceStorageKey = 'wework.workspaceTabs.v2:main'
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
  waitForWorkbenchDebugState,
  captureVerificationScreenshot,
  verifyWorkspaceDocumentTabs,
  verifyDefaultWorkspaceStartupTab,
  configureDefaultProjectSpaceAssociation,
  verifyExplicitlyTrackedTask,
  workspaceTabIds,
  allWorkspaceTabIds,
  waitForAttribute,
  verifyWorkspaceTabIsolation,
}
