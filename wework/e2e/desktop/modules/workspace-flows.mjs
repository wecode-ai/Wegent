import { waitForSnapshot } from './conversation-layout.mjs'

import {
  ensureExperimentalFeaturesDisabled,
  ensureExperimentalFeaturesEnabled,
} from './preferences-automation-flows.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  PROVIDER_SWITCH_OFFICIAL_LABEL,
  PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
  TASK_PROMPT,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  modelOptionIdCandidates,
  revealGroupedModelOption,
  resultDir,
  runChecked,
  visibleModelOptionId,
  withTimeout,
  writeFile,
} from './shared.mjs'

const FIXED_BOARD_ROUTE_TAB_ID = 'fixed-board'
const FIXED_BOARD_TAB_ID = `workspace-tab-${FIXED_BOARD_ROUTE_TAB_ID}`
const FIXED_BOARD_TAB_SELECT_TEST_ID = `workspace-tab-select-${FIXED_BOARD_ROUTE_TAB_ID}`
const FIXED_BOARD_TAB_CONTENT_TEST_ID = `workspace-tab-content-${FIXED_BOARD_ROUTE_TAB_ID}`
const FIXED_BOARD_CONTENT_SELECTOR = `[data-testid="${FIXED_BOARD_TAB_CONTENT_TEST_ID}"]`

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
  await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
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
    text: '工作空间',
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
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
  const boardTabs = workspaceTabIds(JSON.parse(await control.command('snapshot', 'body')), 'board')
  assert.ok(boardTabs.length > 0, 'The workspace issue flow requires an existing board tab')
  const boardTabId = boardTabs[0].slice('workspace-tab-'.length)
  const boardTabSelector = `[data-testid="workspace-tab-select-${boardTabId}"]`
  const boardContentSelector = `[data-testid="workspace-tab-content-${boardTabId}"]`

  await control.command('click', boardTabSelector)
  await control.command('waitFor', `${boardTabSelector}[aria-selected="true"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', `${boardContentSelector} [data-testid="cloud-todo-workspace"]`, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const projectName = 'Workspace Issue E2E'
  const issueTitle =
    'WEWORK_DESKTOP_E2E_ISSUE_TITLE Verify that a deliberately long Issue title wraps across multiple lines in the workspace sidebar without clipping or overlapping the description below it.'
  const issueDescription =
    'WEWORK_DESKTOP_E2E_ISSUE Workspace fullscreen issue creation verified with a deliberately long description that spans more than two lines in the Issue sidebar so collapsed overflow treatment remains visible.'
  const twoLineBreakMarker = '换行标记'
  const twoLineIssueDescription = `折叠描述第一行${twoLineBreakMarker}折叠描述第二行`
  await control.command('click', `${boardContentSelector} [data-testid="cloud-project-add"]`)
  await control.command('waitFor', '[data-testid="cloud-project-name"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="cloud-project-name"]', {
    value: projectName,
  })
  await control.command('click', '[data-testid="cloud-project-location-local"]')
  await control.command('click', '[data-testid="cloud-project-task-provider-local"]')
  await control.command('clickWhenEnabled', '[data-testid="cloud-project-create-confirm"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${boardContentSelector} [data-testid="cloud-project-header-title"]`,
    {
      text: projectName,
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )

  await control.command('click', `${boardContentSelector} [data-testid="cloud-create-issue"]`)
  await control.command('waitFor', '[data-testid="workspace-issue-composer"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    '[data-testid="workspace-issue-composer"] [data-testid="project-chat-composer"]',
    {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command(
    'waitFor',
    '[data-testid="workspace-issue-composer"] [data-testid="attachment-file-input"]',
    {
      visible: false,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command(
    'waitFor',
    '[data-testid="workspace-create-issue-tab"][aria-selected="true"]',
    {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command('click', '[data-testid="workspace-create-task-tab"]')
  await control.command(
    'waitFor',
    '[data-testid="workspace-create-task-tab"][aria-selected="true"]',
    {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="workspace-create-issue-tab"]')
  await control.command('click', '[data-testid="workspace-issue-expand"]')
  await control.command('waitFor', '[data-testid="workspace-issue-description"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', '[data-testid="workspace-issue-description"]', {
      value: 'contenteditable',
    }),
    'true',
    'Expanded Issue description must use the rich Markdown editor'
  )
  const descriptionRegionClass =
    (await control.command('getAttribute', '[data-testid="workspace-issue-description-region"]', {
      value: 'class',
    })) ?? ''
  assert.ok(
    descriptionRegionClass.includes('flex-1') && descriptionRegionClass.includes('min-h-[360px]'),
    `Expanded Issue description must fill the remaining editor height: ${descriptionRegionClass}`
  )
  const expandedPanelClass =
    (await control.command('getAttribute', '[data-testid="workspace-issue-composer-panel"]', {
      value: 'class',
    })) ?? ''
  assert.ok(
    expandedPanelClass.includes('fixed') &&
      expandedPanelClass.includes('left-4') &&
      expandedPanelClass.includes('right-4') &&
      expandedPanelClass.includes('bottom-4') &&
      expandedPanelClass.includes('w-auto'),
    `Expanded Issue editor must cover the complete board workspace with outer margins: ${expandedPanelClass}`
  )
  assert.ok(
    expandedPanelClass.includes('top-[54px]') &&
      !expandedPanelClass.includes('inset-0') &&
      !expandedPanelClass.includes('top-4'),
    `Expanded Issue editor must preserve the 38px app tab chrome plus a 16px margin: ${expandedPanelClass}`
  )
  const editorBodyClass =
    (await control.command('getAttribute', '[data-testid="workspace-issue-editor-body"]', {
      value: 'class',
    })) ?? ''
  assert.ok(
    editorBodyClass.includes('w-full') &&
      editorBodyClass.includes('px-6') &&
      !editorBodyClass.includes('max-w-[960px]'),
    `Expanded Issue content must use the available width with standard gutters: ${editorBodyClass}`
  )
  await control.command('waitFor', '[data-testid="workspace-issue-header-actions"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="workspace-issue-title"]', {
    value: issueTitle,
  })
  await control.command('fill', '[data-testid="workspace-issue-description"]', {
    value: issueDescription,
  })
  await control.command('waitFor', '[data-testid="workspace-issue-draft-status"]', {
    text: '草稿已自动保存',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-issue-01-ready.png')
  await control.command('click', '[data-testid="workspace-issue-close"]')
  await control.command('waitFor', '[data-testid="workspace-issue-composer"]', {
    visible: false,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', `${boardContentSelector} [data-testid="cloud-create-issue"]`)
  await control.command('waitFor', '[data-testid="workspace-issue-input"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="workspace-issue-expand"]')
  await waitForControlValueIncludes(
    control,
    '[data-testid="workspace-issue-description"]',
    issueDescription,
    'Fullscreen Issue content did not survive closing and reopening'
  )
  await waitForControlValueIncludes(
    control,
    '[data-testid="workspace-issue-title"]',
    issueTitle,
    'Fullscreen Issue title did not survive closing and reopening'
  )
  await control.command('click', '[data-testid="workspace-issue-fullscreen-submit"]')
  await control.command(
    'waitFor',
    `${boardContentSelector} [data-testid="cloud-todo-detail-title"]`,
    {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const [issueTitleMetrics] = JSON.parse(
    await control.command(
      'getElementMetrics',
      `${boardContentSelector} [data-testid="cloud-todo-detail-title"]`
    )
  )
  const [issueDescriptionMetrics] = JSON.parse(
    await control.command(
      'getElementMetrics',
      `${boardContentSelector} .task-detail-workspace-description`
    )
  )
  const issueTitleLineHeight = Number.parseFloat(
    await control.command(
      'getComputedStyleValue',
      `${boardContentSelector} [data-testid="cloud-todo-detail-title"]`,
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
  assert.ok(
    issueTitleMetrics.bottom <= issueDescriptionMetrics.top,
    `The Issue sidebar title overlapped the description: ${JSON.stringify({
      title: issueTitleMetrics,
      description: issueDescriptionMetrics,
    })}`
  )
  const collapsedDescriptionSelector = `${boardContentSelector} .task-detail-desc.is-collapsed`
  await waitForAttribute(
    control,
    collapsedDescriptionSelector,
    'data-overflowing',
    'true',
    'The collapsed Issue description did not expose its overflow treatment'
  )
  const [collapsedDescriptionMetrics] = JSON.parse(
    await control.command('getElementMetrics', `${collapsedDescriptionSelector} .bn-editor`)
  )
  const collapsedDescriptionBlocks = JSON.parse(
    await control.command('getElementMetrics', `${collapsedDescriptionSelector} .bn-block-outer`)
  )
  const lastCollapsedDescriptionBlock = collapsedDescriptionBlocks.at(-1)
  const descriptionLineHeight = Number.parseFloat(
    await control.command('getComputedStyleValue', `${collapsedDescriptionSelector} .bn-editor`, {
      value: 'line-height',
    })
  )
  assert.ok(
    collapsedDescriptionMetrics.clientHeight >= descriptionLineHeight * 2,
    `The collapsed Issue description clipped its second line: ${JSON.stringify({
      metrics: collapsedDescriptionMetrics,
      lineHeight: descriptionLineHeight,
    })}`
  )
  assert.ok(
    lastCollapsedDescriptionBlock &&
      lastCollapsedDescriptionBlock.bottom > collapsedDescriptionMetrics.bottom + 1,
    `The overflow regression fixture did not exceed the collapsed description: ${JSON.stringify({
      editor: collapsedDescriptionMetrics,
      lastBlock: lastCollapsedDescriptionBlock,
    })}`
  )
  await captureVerificationScreenshot(
    control,
    'workspace-issue-02-created.png',
    boardContentSelector
  )
  await control.command(
    'fill',
    `${boardContentSelector} [data-testid="cloud-todo-detail-description"]`,
    {
      value: twoLineIssueDescription,
    }
  )
  await control.command(
    'selectText',
    `${boardContentSelector} [data-testid="cloud-todo-detail-description"]`,
    {
      value: twoLineBreakMarker,
    }
  )
  await control.command(
    'press',
    `${boardContentSelector} [data-testid="cloud-todo-detail-description"]`,
    {
      key: 'Enter',
    }
  )
  await waitForElementCount(
    control,
    `${collapsedDescriptionSelector} .bn-block-outer`,
    2,
    'The two-line regression fixture did not split into two editor blocks'
  )
  await waitForAttribute(
    control,
    collapsedDescriptionSelector,
    'data-overflowing',
    'false',
    'A fully visible two-line Issue description still exposed its overflow treatment'
  )
  const [twoLineDescriptionMetrics] = JSON.parse(
    await control.command('getElementMetrics', `${collapsedDescriptionSelector} .bn-editor`)
  )
  const [twoLineDescriptionParagraphMetrics] = JSON.parse(
    await control.command('getElementMetrics', `${collapsedDescriptionSelector} p`)
  )
  const twoLineDescriptionBlocks = JSON.parse(
    await control.command('getElementMetrics', `${collapsedDescriptionSelector} .bn-block-outer`)
  )
  const firstTwoLineDescriptionBlock = twoLineDescriptionBlocks.at(0)
  const lastTwoLineDescriptionBlock = twoLineDescriptionBlocks.at(-1)
  const twoLineDescriptionLineHeight = Number.parseFloat(
    await control.command('getComputedStyleValue', `${collapsedDescriptionSelector} p`, {
      value: 'line-height',
    })
  )
  assert.ok(
    firstTwoLineDescriptionBlock &&
      lastTwoLineDescriptionBlock &&
      lastTwoLineDescriptionBlock.bottom - firstTwoLineDescriptionBlock.top >=
        twoLineDescriptionLineHeight * 2 - 1,
    `The two-line regression fixture did not wrap to two lines: ${JSON.stringify({
      paragraph: twoLineDescriptionParagraphMetrics,
      firstBlock: firstTwoLineDescriptionBlock,
      lastBlock: lastTwoLineDescriptionBlock,
      lineHeight: twoLineDescriptionLineHeight,
    })}`
  )
  assert.ok(
    lastTwoLineDescriptionBlock &&
      lastTwoLineDescriptionBlock.bottom <= twoLineDescriptionMetrics.bottom + 1,
    `The collapsed Issue description clipped a fully visible second line: ${JSON.stringify({
      editor: twoLineDescriptionMetrics,
      lastBlock: lastTwoLineDescriptionBlock,
    })}`
  )
  const issueStatusSelector = `${boardContentSelector} [data-testid="cloud-todo-detail-status"]`
  await control.command('select', issueStatusSelector, { value: 'pending' })
  assert.equal(
    await control.command('getValue', issueStatusSelector),
    'pending',
    'The Issue did not enter pending before verifying its task composer'
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
  await control.command('click', `${boardContentSelector} [data-testid="cloud-todo-create-task"]`)
  const activeTaskPanel = `${boardContentSelector} [data-testid="cloud-todo-panel-stack"][data-conversation-open="true"]`
  const taskPanelBackdrop = '[data-testid="ai-chat-modal-backdrop"][data-presentation="sidebar"]'
  await control.command('waitFor', activeTaskPanel, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', taskPanelBackdrop, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', taskPanelBackdrop, {
      value: 'data-presentation',
      visible: true,
    }),
    'sidebar',
    'Creating a task from an Issue did not open the embedded conversation sidebar'
  )
  await control.command('waitFor', '[data-testid="work-item-new-task-chat-panel"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const taskComposerSelector = '[data-testid="work-item-new-task-chat-panel"]'
  const modelSelectorButton = `${taskComposerSelector} [data-testid="model-selector-button"]`
  const currentModelLabel = await control.command('getText', modelSelectorButton, {
    visible: true,
  })
  const targetModel = currentModelLabel.includes(DEFAULT_MODEL_LABEL)
    ? {
        id: PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
        label: PROVIDER_SWITCH_OFFICIAL_LABEL,
      }
    : { id: DEFAULT_MODEL_ID, label: DEFAULT_MODEL_LABEL }
  await control.command('clickWhenEnabled', modelSelectorButton, {
    stableMs: 100,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    visible: true,
  })
  await control.command('waitFor', '[data-testid="model-selector-menu"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('hover', '[data-testid="model-control-menu-model"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="model-selector-submenu"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  let targetOptionId = await visibleModelOptionId(control, modelOptionIdCandidates(targetModel.id))
  if (!targetOptionId) {
    await revealGroupedModelOption(control, modelOptionIdCandidates(targetModel.id))
    targetOptionId = await visibleModelOptionId(control, modelOptionIdCandidates(targetModel.id))
  }
  assert.ok(targetOptionId, `No visible model option matched ${targetModel.id}`)
  await control.command(
    'click',
    `[data-testid="model-selector-submenu"] [data-testid="${targetOptionId}"]`
  )
  const switchedModelSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    switchedModelSnapshot.testIds.includes('model-switch-warning-dialog'),
    false,
    'A fresh board task composer was treated as an existing conversation while switching models'
  )
  await control.command('waitFor', modelSelectorButton, {
    text: targetModel.label,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const addContextButton = `${taskComposerSelector} [data-testid="add-context-button"]`
  await control.command('click', addContextButton, { visible: true })
  await control.command('waitFor', '[data-testid="set-goal-button"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="set-goal-button"]', { visible: true })
  const goalDraftSnapshot = JSON.parse(await control.command('snapshot', taskComposerSelector))
  assert.equal(
    goalDraftSnapshot.testIds.includes('goal-draft-pill'),
    true,
    'Selecting Goal mode did not activate the Goal draft'
  )
  await captureVerificationScreenshot(control, 'workspace-issue-03-new-task-sidebar.png')
  await control.command('hover', '[data-testid="goal-draft-pill"]', {
    visible: true,
  })
  await control.command('click', '[data-testid="cancel-goal-draft-button"]', { visible: true })
  const cancelledGoalSnapshot = JSON.parse(await control.command('snapshot', taskComposerSelector))
  assert.equal(
    cancelledGoalSnapshot.testIds.includes('goal-draft-pill'),
    false,
    'Cancelling Goal mode left the Goal draft active'
  )
  await control.command('click', `${taskPanelBackdrop} [data-testid="ai-chat-modal-close"]`)

  await control.command('click', boardTabSelector)
  await control.command('waitFor', `${boardContentSelector} [data-testid="cloud-todo-workspace"]`, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
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

async function requireActiveFixedBoardTab(control, message) {
  await control.command('waitFor', '[data-tab-kind="board"][aria-selected="true"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const activeBoardTabTestId = await control.command(
    'getAttribute',
    '[data-tab-kind="board"][aria-selected="true"]',
    { value: 'data-testid' }
  )
  assert.equal(activeBoardTabTestId, FIXED_BOARD_TAB_SELECT_TEST_ID, message)
  const boardTabs = workspaceTabIds(JSON.parse(await control.command('snapshot', 'body')), 'board')
  assert.deepEqual(
    boardTabs,
    [FIXED_BOARD_TAB_ID],
    'Opening the bound project space created a duplicate board tab'
  )
  return FIXED_BOARD_CONTENT_SELECTOR
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
  const activeBoardContentSelector = await requireActiveFixedBoardTab(
    control,
    'The first work-item navigation did not reuse the unresolved fixed project-space tab'
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
    'drag',
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
  const activeBoardContentSelector = await requireActiveFixedBoardTab(
    control,
    'The settled work-item navigation did not reuse the fixed project-space tab'
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
  const contextSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.some(testId => testId.startsWith('cloud-todo-open-task-conversation-')),
    'The linked task conversation control was not rendered'
  )
  const contextTaskTestId = contextSnapshot.testIds.find(testId =>
    testId.startsWith('cloud-todo-open-task-conversation-')
  )
  assert.ok(contextTaskTestId, 'The linked task conversation control was not rendered')
  await control.command('click', `[data-testid="${contextTaskTestId}"]`)
  await control.command('waitFor', `[data-testid="${taskTabTestId}"][aria-selected="true"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="work-item-open-board"]')
  const activeBoardContentSelector = await requireActiveFixedBoardTab(
    control,
    'The tracked work-item navigation did not reuse the fixed project-space tab'
  )
  await waitForStableSnapshot(
    control,
    snapshot =>
      snapshot.location.includes(`workspaceTab=${FIXED_BOARD_ROUTE_TAB_ID}`) &&
      !snapshot.location.includes('itemId=') &&
      snapshot.testIds.includes(FIXED_BOARD_TAB_CONTENT_TEST_ID) &&
      !snapshot.testIds.includes('cloud-todo-board-loading') &&
      snapshot.text.includes('WEWORK_DESKTOP_E2E_TASK'),
    'The work-item board did not settle on the tracked task awaiting confirmation'
  )
  await control.command(
    'waitFor',
    `${activeBoardContentSelector} [data-testid="cloud-todo-column-in_review"]`,
    {
      text: 'WEWORK_DESKTOP_E2E_TASK',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
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
  await control.command('markElementWithText', boardCardSelector, {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    value: 'tracked-work-item-card',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'click',
    `${activeBoardContentSelector} [data-e2e-anchor-id="tracked-work-item-card"]`
  )
  await control.command('waitFor', '[data-testid="cloud-todo-detail"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const activeTaskConversationSelector = '[data-testid^="cloud-todo-open-task-conversation-"]'
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
    `${activeBoardContentSelector} [data-testid="cloud-todo-workspace"][data-embedded="false"]`,
    {
      visible: true,
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
  const activeBoardContentSelector = await requireActiveFixedBoardTab(
    control,
    'The source work-item navigation did not reuse the fixed project-space tab'
  )
  const targetProjectName = 'Existing Task Target Board'
  await control.command('click', `${activeBoardContentSelector} [data-testid="cloud-project-add"]`)
  await control.command('waitFor', '[data-testid="cloud-project-name"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="cloud-project-name"]', {
    value: targetProjectName,
  })
  await control.command('click', '[data-testid="cloud-project-location-local"]')
  await control.command('click', '[data-testid="cloud-project-task-provider-local"]')
  await control.command('clickWhenEnabled', '[data-testid="cloud-project-create-confirm"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${activeBoardContentSelector} [data-testid="cloud-project-header-title"]`,
    {
      text: targetProjectName,
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const existingTargetTitle = 'WEWORK_EXISTING_BOARD_CARD'
  await control.command('click', `${activeBoardContentSelector} [data-testid="cloud-create-issue"]`)
  await control.command('waitFor', '[data-testid="workspace-issue-input"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="workspace-issue-input"]', {
    value: existingTargetTitle,
  })
  await control.command('clickWhenEnabled', '[data-testid="workspace-issue-submit"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${activeBoardContentSelector} [data-testid="cloud-todo-column-inbox"]`,
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
  const movedBoardContentSelector = await requireActiveFixedBoardTab(
    control,
    'The moved work-item navigation did not continue reusing the fixed project-space tab'
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
  await control.command(
    'waitFor',
    `${movedBoardContentSelector} [data-testid="cloud-todo-column-in_review"]`,
    {
      text: 'WEWORK_DESKTOP_E2E_TASK',
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
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

async function waitForElementCount(control, selector, expected, message) {
  const startedAt = Date.now()
  let actual = 0
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    actual = Number(await control.command('getElementCount', selector))
    if (actual === expected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${message}: expected ${expected}, received ${actual}`)
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
  verifyExistingTaskBoardAssociation,
  verifyExplicitlyTrackedTask,
  workspaceTabIds,
  allWorkspaceTabIds,
  waitForAttribute,
  verifyWorkspaceTabIsolation,
}
