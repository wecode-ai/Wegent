import { waitForElementWidth, waitForSnapshot } from './conversation-layout.mjs'

import {
  ACTIVE_WORKBENCH_SELECTOR,
  COMPLETION_TEXT,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  DROPPED_PATH_COMPLETION_TEXT,
  DROPPED_PATH_FILE_NAME,
  DROPPED_PATH_FOLDER_NAME,
  IMAGE_ARTIFACT_BASE64,
  PASTED_PATH_COMPLETION_TEXT,
  PASTED_PATH_FILE_NAME,
  PASTED_PATH_FOLDER_NAME,
  PASTED_ZIP_BASE64,
  PASTED_ZIP_COMPLETION_TEXT,
  PASTED_ZIP_FILENAME,
  SIDE_CHAT_COMPLETION_TEXT,
  SIDE_CHAT_FILENAME,
  SIDE_CHAT_GUIDANCE_FOLLOW_UP,
  SIDE_CHAT_GUIDANCE_INITIAL,
  SIDE_CHAT_PROMPT,
  SIDE_CHAT_QUEUE_FOLLOW_UP,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  mkdir,
  pathToFileURL,
  resultDir,
  withTimeout,
  writeFile,
} from './shared.mjs'

import { captureVerificationScreenshot } from './workspace-flows.mjs'

const TERMINAL_DRAG_TEXT = 'WEWORK_TERMINAL_DRAG_E2E'
const SELECTED_TEXT_FILE_NAME = 'selected-text-drag.ts'
const SELECTED_TEXT_FILE_CONTENT = 'export const selectedTextDrag = true\n'

async function waitForSystemDragPanelVisibility(control, expected, message) {
  const expectedValue = String(expected)
  const startedAt = Date.now()
  let lastValue = ''
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    lastValue = await control.command('getSystemDragPanelVisibility', 'body')
    if (lastValue === expectedValue) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${message}: observed=${lastValue}`)
}

async function verifyComposerEditorScroll({ composerSelector, control }) {
  const scrollSelector =
    '[data-testid="project-chat-composer-content"] [data-composer-scroll-container]'
  const cardSelector = '[data-testid="attachment-badge"]'
  const table = '| test-a | test-b |\n| --- | --- |\n| one | two |'
  const draft =
    table + '\n' + Array.from({ length: 60 }, (_, index) => 'test line ' + index).join('\n')
  await control.command('fill', composerSelector, { value: draft })
  await control.command('scrollToRatioAsUser', scrollSelector, { value: '0' })
  const metrics = async selector =>
    JSON.parse(await control.command('getElementMetrics', selector))[0]
  const top = await metrics(scrollSelector)
  const cardAtTop = await metrics(cardSelector)
  const tableAtTop = await metrics(composerSelector + ' table')
  const toolbarAtTop = await metrics('[data-testid="send-message-button"]')
  assert.ok(top.scrollHeight > top.clientHeight, 'The editor viewport must scroll for long drafts')
  assert.ok(cardAtTop.bottom <= top.top, 'The attachment must remain above the editor viewport')
  assert.ok(
    tableAtTop.top >= cardAtTop.bottom,
    'The attachment must not overlap the first table row'
  )
  assert.ok(tableAtTop.top >= top.top, 'Scrolling to the top must reveal the table header')
  await control.command('scrollToRatioAsUser', scrollSelector, { value: '1' })
  const bottom = await metrics(scrollSelector)
  const cardAtBottom = await metrics(cardSelector)
  const editor = await metrics(composerSelector)
  const toolbarAtBottom = await metrics('[data-testid="send-message-button"]')
  assert.ok(bottom.scrollTop > 0, 'The editor viewport did not scroll')
  assert.ok(
    Math.abs(cardAtTop.top - cardAtBottom.top) < 1,
    'Editor scrolling must not move attachments'
  )
  assert.equal(editor.scrollTop, 0, 'The editor must not have a separate vertical scroll position')
  assert.ok(
    editor.scrollHeight <= editor.clientHeight + 1,
    'The editor must grow with its full document'
  )
  assert.ok(
    Math.abs(toolbarAtBottom.top - toolbarAtTop.top) < 1,
    'Scrolling content moved the send toolbar'
  )
  await control.command('scrollToRatioAsUser', scrollSelector, { value: '0' })
  await control.command('fill', composerSelector, { value: '@' })
  await control.command('press', composerSelector, { key: 'ArrowDown' })
  await control.command('waitFor', '[data-testid="local-skill-autocomplete"]')
  const menu = await metrics('[data-testid="local-skill-autocomplete"]')
  const viewport = await metrics(scrollSelector)
  assert.ok(
    menu.bottom <= viewport.top,
    'The autocomplete menu must open outside the clipped content'
  )
  await control.command('press', composerSelector, { key: 'Escape' })
  await control.command('fill', composerSelector, { value: '' })
}

async function verifyPastedZipAttachment({ composerSelector, control }) {
  control.setScenario('pasted_zip_attachment')
  await control.command('snapshot', 'body')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  const shortPaste = 'test\n'.repeat(999)
  await control.command('pasteText', composerSelector, { value: shortPaste })
  assert.equal(await control.command('getValue', composerSelector), shortPaste)
  assert.equal(
    JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)).testIds.includes(
      'attachment-badge'
    ),
    false
  )
  await control.command('fill', composerSelector, { value: '' })
  const oversizedPaste = 'test '.repeat(5001)
  await control.command('pasteText', composerSelector, { value: oversizedPaste })
  await control.command('waitFor', '[data-testid="attachment-text-open-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)).testIds.includes(
      'show-text-attachment-button'
    ),
    false,
    'Pastes over 25000 characters must remain attachments'
  )
  await control.command('click', '[data-testid="remove-attachment-button"]')
  const longPaste = 'test\n'.repeat(1000)
  await control.command('pasteText', composerSelector, { value: longPaste })
  await control.command('waitFor', '[data-testid="attachment-text-preview"]', {
    text: 'test',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(await control.command('getValue', composerSelector), '')
  await control.command('pasteFile', composerSelector, {
    filename: PASTED_ZIP_FILENAME,
    mimeType: 'application/zip',
    value: PASTED_ZIP_BASE64,
  })
  await control.command('waitFor', '[data-testid="attachment-badge"]', {
    text: PASTED_ZIP_FILENAME,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const [fileTile, pastedTextCard] = JSON.parse(
    await control.command('getElementMetrics', '[data-testid="attachment-badge"]')
  )
  const [preview] = JSON.parse(
    await control.command('getElementMetrics', '[data-testid="attachment-document-icon"]')
  )
  assert.deepEqual(
    { width: fileTile.width, height: fileTile.height, previewHeight: preview.height },
    { width: 160, height: 122, previewHeight: 90 },
    'The composer file tile must keep its preview and filename footer dimensions'
  )
  assert.equal(
    await control.command(
      'getText',
      '[data-testid="attachment-badge-list"] > [data-testid="attachment-badge"]:first-child'
    ),
    PASTED_ZIP_FILENAME,
    'A file added after pasted text must appear before the pasted-text card'
  )
  assert.ok(pastedTextCard, 'The pasted-text card disappeared when adding a file')
  assert.ok(
    Math.abs(fileTile.bottom - pastedTextCard.bottom) < 1,
    'Mixed attachment cards must align at the bottom'
  )
  await control.command('click', '[data-testid="show-text-attachment-button"]')
  assert.equal(await control.command('getValue', composerSelector), longPaste)
  assert.equal(
    JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)).testIds.includes(
      'attachment-text-preview'
    ),
    false
  )
  await control.command('pasteFile', composerSelector, {
    filename: 'test-image.png',
    mimeType: 'image/png',
    value: IMAGE_ARTIFACT_BASE64,
  })
  await control.command('waitFor', '[data-testid="attachment-image-preview-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const imageTileSelector =
    '[data-testid="attachment-badge"]:has([data-testid="attachment-image-preview-button"])'
  const [imageTile] = JSON.parse(await control.command('getElementMetrics', imageTileSelector))
  assert.deepEqual(
    { width: imageTile.width, height: imageTile.height },
    { width: fileTile.width, height: fileTile.height },
    'Image and document composer tiles must use the same dimensions'
  )
  await control.command('click', '[data-testid="attachment-image-preview-button"]')
  await control.command('waitFor', '[data-testid="attachment-image-lightbox"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="attachment-image-lightbox-close"]')
  await verifyComposerEditorScroll({ composerSelector, control })
  await control.command('hover', imageTileSelector)
  await control.command('click', `${imageTileSelector} [data-testid="remove-attachment-button"]`)
  await control.command('fill', composerSelector, { value: '' })
  await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.awaitScenarioRequestCount('pasted_zip_attachment', 1)
  await control.command('waitFor', '[data-testid="message-document-attachment"]', {
    text: PASTED_ZIP_FILENAME,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: PASTED_ZIP_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'pasted-zip-attachment.png')
}

async function verifySystemDragPanelLayout(control) {
  await control.command('navigate', 'body', { value: '/system-drag' })
  await control.command('waitFor', '[data-testid="system-drag-panel"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    visible: true,
  })
  const [metrics] = JSON.parse(
    await control.command('getElementMetrics', '[data-testid="system-drag-panel"]')
  )
  assert.deepEqual(
    { height: metrics.height, width: metrics.width },
    { height: 60, width: 440 },
    'The system drag panel did not use the compact desktop dimensions'
  )
  const snapshot = JSON.parse(
    await control.command('snapshot', '[data-testid="system-drag-panel"]')
  )
  assert.match(
    snapshot.text,
    /Create new chat|创建新对话/,
    'The system drag panel did not expose the new-chat destination'
  )
  assert.match(
    snapshot.text,
    /Temporary stash|临时暂存/,
    'The system drag panel did not expose the stash destination'
  )
  assert.ok(
    snapshot.testIds.includes('system-drag-close-button'),
    'The system drag panel did not expose a manual close button'
  )
  await captureVerificationScreenshot(
    control,
    'system-drag-panel.png',
    '[data-testid="system-drag-panel"]'
  )
  await control.command('showSystemDragPanel', 'body')
  await waitForSystemDragPanelVisibility(
    control,
    true,
    'The native system drag panel did not become visible for manual-close verification'
  )
  await control.command('click', '[data-testid="system-drag-close-button"]', { visible: true })
  await waitForSystemDragPanelVisibility(
    control,
    false,
    'Clicking the system drag close button did not hide the native panel window'
  )
  await control.command('showSystemDragPanel', 'body')
  await waitForSystemDragPanelVisibility(
    control,
    true,
    'The native system drag panel did not reopen for Escape verification'
  )
  await control.command('press', '[data-testid="system-drag-close-button"]', { key: 'Escape' })
  await waitForSystemDragPanelVisibility(
    control,
    false,
    'Pressing Escape did not hide the native system drag panel window'
  )
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', '[data-testid="new-chat-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const focusSnapshot = JSON.parse(
    await control.command('completeSystemDragDrop', 'body', {
      value: JSON.stringify({
        action: 'new-chat',
        text: 'System drag Popout Window verification',
        paths: [],
      }),
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
  )
  try {
    assert.equal(
      focusSnapshot.mainFocused,
      false,
      'Completing a system drag incorrectly focused the main window'
    )
    assert.equal(
      focusSnapshot.popoutExists && focusSnapshot.popoutVisible,
      true,
      'Completing a system drag did not reveal the Popout Window'
    )
    if (process.platform === 'darwin') {
      const dataUrl = await control.command('capturePopoutWindow', 'body', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const prefix = 'data:image/png;base64,'
      assert.ok(dataUrl.startsWith(prefix), 'System drag did not reveal a capturable Popout Window')
      const png = Buffer.from(dataUrl.slice(prefix.length), 'base64')
      assert.ok(png.length > 10_000, 'System drag revealed an empty Popout Window')
      await writeFile(join(resultDir, 'system-drag-popout-window.png'), png)
    }
  } finally {
    await control.command('dismissPopoutWindow', 'body')
  }
}

async function verifySentWorkspacePaths(control, folderName, fileName) {
  const token = folderName.replace(/[^a-zA-Z0-9_-]/g, '-')
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="sent-folder-token-${token}"]`,
    {
      text: folderName,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-text-attachment"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    snapshot.testIds.includes(`sent-file-token-${fileName.replace(/[^a-zA-Z0-9_-]/g, '-')}`),
    false,
    'An added file was serialized as an inline file mention'
  )
}

async function verifyPersistedWorkspacePaths(control, folderName, fileName, completionText) {
  await verifySentWorkspacePaths(control, folderName, fileName)
  const readyCount = control.readyCount
  await control.command('reloadMainWindow', 'body')
  await withTimeout(
    control.awaitReadyAfter(readyCount),
    WORKBENCH_READY_TIMEOUT_MS,
    'The path reference reload did not reconnect to the desktop controller'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: completionText,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await verifySentWorkspacePaths(control, folderName, fileName)
}

async function verifyPastedWorkspacePaths({ composerSelector, control, workspacePath }) {
  control.setScenario('pasted_workspace_paths')
  const folderPath = join(workspacePath, PASTED_PATH_FOLDER_NAME)
  const filePath = join(workspacePath, PASTED_PATH_FILE_NAME)
  await mkdir(folderPath, { recursive: true })
  await writeFile(join(folderPath, 'nested.txt'), 'nested path context\n')
  await writeFile(filePath, '# Pasted path context\n')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('pasteFile', composerSelector, {
    filename: 'test-preview.csv',
    mimeType: 'text/csv',
    value: Buffer.from('test,value\none,two\n').toString('base64'),
  })
  await control.command('waitFor', '[data-testid="attachment-document-preview-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="attachment-document-preview-button"]')
  await control.command('waitFor', '[data-testid="composer-attachment-preview-panel"]', {
    text: 'test-preview.csv',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="workspace-binary-file-preview"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="right-workspace-file-tab-close-button"]')
  assert.equal(await control.command('getValue', composerSelector), '')
  await control.command('hover', '[data-testid="attachment-badge"]')
  await control.command('click', '[data-testid="remove-attachment-button"]')
  await control.command('pastePaths', composerSelector, {
    value: JSON.stringify([
      {
        uri: pathToFileURL(folderPath).href,
        name: PASTED_PATH_FOLDER_NAME,
        isDirectory: true,
      },
      {
        uri: pathToFileURL(filePath).href,
        name: PASTED_PATH_FILE_NAME,
        mimeType: 'text/markdown',
      },
    ]),
  })
  await control.command(
    'waitFor',
    `[data-testid="composer-path-chip-${PASTED_PATH_FOLDER_NAME}"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', '[data-testid="attachment-badge"]', {
    text: PASTED_PATH_FILE_NAME,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    snapshot.testIds.includes('composer-path-chip-pasted-context-md'),
    false,
    'A pasted file was incorrectly inserted into the message text'
  )
  await captureVerificationScreenshot(control, 'pasted-workspace-paths.png')
  await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.awaitScenarioRequestCount('pasted_workspace_paths', 1)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: PASTED_PATH_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await verifyPersistedWorkspacePaths(
    control,
    PASTED_PATH_FOLDER_NAME,
    PASTED_PATH_FILE_NAME,
    PASTED_PATH_COMPLETION_TEXT
  )
}

async function verifyDroppedWorkspacePaths({ composerSelector, control, workspacePath }) {
  const folderPath = join(workspacePath, DROPPED_PATH_FOLDER_NAME)
  const filePath = join(workspacePath, DROPPED_PATH_FILE_NAME)
  await mkdir(folderPath, { recursive: true })
  await writeFile(join(folderPath, 'nested.txt'), 'nested dropped path context\n')
  await writeFile(filePath, '# Dropped path context\n')
  await writeFile(join(workspacePath, SELECTED_TEXT_FILE_NAME), SELECTED_TEXT_FILE_CONTENT)

  control.setScenario('workspace_selection_streaming')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('fill', composerSelector, {
    value: 'WEWORK_DESKTOP_E2E_WORKSPACE_SELECTION_STREAMING',
  })
  await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.awaitScenarioRequestCount('workspace_selection_streaming', 1)
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
  await control.command('click', '[data-testid="right-workspace-file-option"]')
  await control.command('waitFor', `[data-item-path="${DROPPED_PATH_FILE_NAME}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('dragDataTransferStart', `[data-item-path="${DROPPED_PATH_FILE_NAME}"]`)
  await waitForSystemDragPanelVisibility(
    control,
    true,
    'Dragging a right-sidebar workspace file did not show the system drag panel'
  )
  await control.command('dragDataTransferEnd', `[data-item-path="${DROPPED_PATH_FILE_NAME}"]`, {
    target: composerSelector,
  })
  await waitForSystemDragPanelVisibility(
    control,
    false,
    'The system drag panel did not close after the workspace-file drag ended'
  )
  await control.command('waitFor', '[data-testid="composer-path-chip-dropped-context-md"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const sidebarDragSnapshot = JSON.parse(
    await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
  )
  assert.equal(
    sidebarDragSnapshot.testIds.includes('attachment-badge'),
    false,
    'Dragging a right-sidebar workspace file copied it into attachment uploads'
  )
  await captureVerificationScreenshot(control, 'right-sidebar-workspace-file-drag.png')
  await control.command('fill', composerSelector, { value: '' })

  await control.command('click', `[data-item-path="${SELECTED_TEXT_FILE_NAME}"]`)
  await control.command('waitFor', '[data-testid="workspace-file-editor"] .cm-content', {
    text: SELECTED_TEXT_FILE_CONTENT.trim(),
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('press', '[data-testid="workspace-file-editor"] .cm-content', {
    key: process.platform === 'darwin' ? 'Meta+a' : 'Control+a',
  })
  await control.command('waitFor', '[data-testid="workspace-selection-actions"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-editor-selection-actions.png')
  assert.equal(
    await control.command('getSystemDragPanelVisibility', 'body'),
    'false',
    'Selecting CodeMirror workspace text incorrectly opened the system drag panel'
  )
  await control.command('click', '[data-testid="add-workspace-selection-to-conversation-button"]')
  assert.equal(
    await control.command('getValue', composerSelector),
    SELECTED_TEXT_FILE_CONTENT.trim(),
    'The CodeMirror selection action did not insert text into the composer'
  )
  await control.command('fill', composerSelector, { value: '' })
  await control.command('press', '[data-testid="workspace-file-editor"] .cm-content', {
    key: process.platform === 'darwin' ? 'Meta+a' : 'Control+a',
  })
  await control.command(
    'dragDataTransferStart',
    '[data-testid="workspace-file-editor"] .cm-content'
  )
  await waitForSystemDragPanelVisibility(
    control,
    true,
    'Dragging CodeMirror workspace text did not show the system drag panel'
  )
  await control.command('dragDataTransferEnd', 'body', { target: composerSelector })
  await waitForSystemDragPanelVisibility(
    control,
    false,
    'The system drag panel did not close after the selected-text drag ended'
  )
  assert.equal(
    await control.command('getValue', composerSelector),
    SELECTED_TEXT_FILE_CONTENT,
    'Dragging selected workspace editor text did not insert it into the composer'
  )
  assert.equal(
    await control.command('getValue', '[data-testid="workspace-file-editor"] .cm-content'),
    SELECTED_TEXT_FILE_CONTENT.trim(),
    'Dragging selected workspace editor text removed it from the source editor'
  )
  await captureVerificationScreenshot(control, 'workspace-editor-selection-drag.png')
  await control.command('fill', composerSelector, { value: '' })

  await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
  await control.command('waitFor', '.xterm-accessibility-tree [role="listitem"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('terminalInput', '[data-testid="embedded-local-terminal"]', {
    value: `printf '${TERMINAL_DRAG_TEXT}\\n'\r`,
  })
  await control.command('waitFor', '.xterm-accessibility-tree [role="listitem"]', {
    text: TERMINAL_DRAG_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const selectedTerminalText = await control.command(
    'selectTerminalText',
    '.xterm-accessibility-tree [role="listitem"]',
    { value: TERMINAL_DRAG_TEXT }
  )
  assert.equal(
    selectedTerminalText,
    TERMINAL_DRAG_TEXT,
    'The terminal did not expose the expected selectable output'
  )
  await control.command('waitFor', '[data-testid="workspace-selection-actions"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'terminal-selection-actions.png')
  assert.equal(
    await control.command('getSystemDragPanelVisibility', 'body'),
    'false',
    'Selecting terminal text incorrectly opened the system drag panel'
  )
  await control.command('click', '[data-testid="add-workspace-selection-to-conversation-button"]')
  assert.match(
    await control.command('getValue', composerSelector),
    new RegExp(TERMINAL_DRAG_TEXT),
    'The terminal selection action did not insert text into the composer'
  )
  await control.command('fill', composerSelector, { value: '' })
  await control.command('selectTerminalText', '.xterm-accessibility-tree [role="listitem"]', {
    value: TERMINAL_DRAG_TEXT,
  })
  await control.command('waitFor', '[data-testid="xterm-selection-drag-region"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('dragDataTransferStart', '[data-testid="xterm-selection-drag-region"]')
  await waitForSystemDragPanelVisibility(
    control,
    true,
    'Dragging terminal text did not show the system drag panel'
  )
  await control.command('dragDataTransferEnd', 'body', { target: composerSelector })
  await waitForSystemDragPanelVisibility(
    control,
    false,
    'The system drag panel did not close after the terminal selection drag ended'
  )
  assert.match(
    await control.command('getValue', composerSelector),
    new RegExp(TERMINAL_DRAG_TEXT),
    'Dragging selected terminal text did not insert the expected output into the composer'
  )
  await captureVerificationScreenshot(control, 'terminal-selection-drag.png')
  await control.command('fill', composerSelector, { value: '' })
  await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')

  control.setScenario('dropped_workspace_paths')
  await control.command('dropPaths', composerSelector, {
    value: JSON.stringify([
      {
        uri: pathToFileURL(folderPath).href,
        name: DROPPED_PATH_FOLDER_NAME,
        isDirectory: true,
      },
      {
        uri: pathToFileURL(filePath).href,
        name: DROPPED_PATH_FILE_NAME,
        mimeType: 'text/markdown',
      },
    ]),
  })
  await control.command(
    'waitFor',
    `[data-testid="composer-path-chip-${DROPPED_PATH_FOLDER_NAME}"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', '[data-testid="attachment-badge"]', {
    text: DROPPED_PATH_FILE_NAME,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    snapshot.testIds.includes('composer-path-chip-dropped-context-md'),
    false,
    'A dropped file was incorrectly inserted into the message text'
  )
  await captureVerificationScreenshot(control, 'dropped-workspace-paths.png')
  await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.awaitScenarioRequestCount('dropped_workspace_paths', 1)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: DROPPED_PATH_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await verifyPersistedWorkspacePaths(
    control,
    DROPPED_PATH_FOLDER_NAME,
    DROPPED_PATH_FILE_NAME,
    DROPPED_PATH_COMPLETION_TEXT
  )
}

async function verifySideChatAttachmentIsolation({
  control,
  expectedCompletionText = COMPLETION_TEXT,
  taskRowTestId,
}) {
  const sideChatSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-chat-panel"]`
  const rightPanelShellSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel-shell"]`
  const mainComposerSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-floating-composer-card"]`
  const sideComposerSelector = `${sideChatSelector} [data-testid="chat-message-input"]`

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-empty-composer-frame"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await waitForSnapshot(
    control,
    snapshot => snapshot.text.includes(expectedCompletionText),
    'The source conversation did not restore before opening the side chat',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  control.setScenario('side_chat_attachment')
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
  await control.command('click', '[data-testid="right-workspace-chat-option"]')
  await control.command('waitFor', sideComposerSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })

  await waitForElementWidth(
    control,
    rightPanelShellSelector,
    width => width >= 400 && width <= 440,
    'The temporary-chat-only right panel'
  )
  await captureVerificationScreenshot(control, '01-side-chat-compact-width.png')

  await control.command('dropFile', sideComposerSelector, {
    filename: SIDE_CHAT_FILENAME,
    mimeType: 'image/png',
    value: IMAGE_ARTIFACT_BASE64,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('attachment-badge') &&
      !snapshot.testIds.includes('uploading-attachment-badge'),
    'The side-chat attachment did not finish uploading',
    DEFAULT_STEP_TIMEOUT_MS,
    sideChatSelector
  )
  const mainBeforeSend = JSON.parse(await control.command('snapshot', mainComposerSelector))
  assert.equal(
    mainBeforeSend.testIds.includes('attachment-badge'),
    false,
    'Uploading in the side chat leaked an attachment into the main composer'
  )
  await captureVerificationScreenshot(control, '02-side-chat-attachment-isolated.png')

  await control.command('fill', sideComposerSelector, { value: SIDE_CHAT_PROMPT })
  assert.equal(
    await control.command('getValue', sideComposerSelector),
    SIDE_CHAT_PROMPT,
    'The side-chat prompt did not reach the isolated composer'
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, COMPOSER_READY_STABILITY_MS))
  await control.command('click', `${sideChatSelector} [data-testid="send-message-button"]`)
  await control.awaitScenarioRequestCount('side_chat_attachment', 1)
  await control.command('waitFor', `${sideChatSelector} [data-testid="message-assistant"]`, {
    text: SIDE_CHAT_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', `${sideChatSelector} [data-testid="message-image-preview"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const sideAfterSend = JSON.parse(await control.command('snapshot', sideChatSelector))
  assert.equal(
    sideAfterSend.testIds.includes('attachment-badge'),
    false,
    'The sent side-chat attachment was not cleared from its composer'
  )
  const mainAfterSend = JSON.parse(await control.command('snapshot', mainComposerSelector))
  assert.equal(
    mainAfterSend.testIds.includes('attachment-badge'),
    false,
    'Sending the side chat leaked an attachment into the main composer'
  )
  await captureVerificationScreenshot(control, '03-side-chat-sent-main-clean.png')

  control.setScenario('side_chat_guidance')
  await control.command('fill', sideComposerSelector, { value: SIDE_CHAT_GUIDANCE_INITIAL })
  await control.command('click', `${sideChatSelector} [data-testid="send-message-button"]`)
  await control.awaitScenarioRequestCount('side_chat_guidance', 1)
  await control.command('fill', sideComposerSelector, { value: SIDE_CHAT_QUEUE_FOLLOW_UP })
  await control.command('click', `${sideChatSelector} [data-testid="send-message-button"]`)
  await control.command('waitFor', `${sideChatSelector} [data-testid="conversation-queue-panel"]`, {
    text: SIDE_CHAT_QUEUE_FOLLOW_UP,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const queuedSideChat = JSON.parse(await control.command('snapshot', sideChatSelector))
  assert.equal(
    queuedSideChat.testIds.includes('chat-input-error'),
    false,
    'The side chat exposed a runtime busy error instead of queueing the follow-up'
  )
  await captureVerificationScreenshot(control, '04-side-chat-follow-up-queued.png')
  await control.command('click', `${sideChatSelector} [data-testid^="queue-more-button-"]`)
  await control.command('click', '[data-testid^="queue-edit-button-"]')
  await control.command('waitFor', sideComposerSelector, {
    text: SIDE_CHAT_QUEUE_FOLLOW_UP,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'Editing a side-chat reply did not remove its pending queue entry',
    DEFAULT_STEP_TIMEOUT_MS,
    sideChatSelector
  )
  await control.command('click', `${sideChatSelector} [data-testid="send-message-button"]`)
  await control.command('waitFor', `${sideChatSelector} [data-testid="conversation-queue-panel"]`, {
    text: SIDE_CHAT_QUEUE_FOLLOW_UP,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', `${sideChatSelector} [data-testid^="queue-cancel-button-"]`)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'The side-chat queued follow-up could not be cancelled',
    DEFAULT_STEP_TIMEOUT_MS,
    sideChatSelector
  )

  await control.command('fill', sideComposerSelector, { value: SIDE_CHAT_GUIDANCE_FOLLOW_UP })
  await control.command('click', `${sideChatSelector} [data-testid="send-mode-menu-button"]`)
  await control.command('click', '[data-testid="guide-current-turn-option"]')
  await control.command('waitFor', `${sideChatSelector} [data-testid="conversation-queue-panel"]`, {
    text: SIDE_CHAT_GUIDANCE_FOLLOW_UP,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const sideChatGuidanceStatus = await control.command(
    'getText',
    `${sideChatSelector} [data-testid="conversation-queue-panel"]`
  )
  assert.match(
    sideChatGuidanceStatus,
    /引导中|Guiding/,
    'The side-chat follow-up was queued instead of guiding the active turn'
  )
  await captureVerificationScreenshot(control, '05-side-chat-follow-up-guiding.png')
  control.releaseSideChatGuidanceResponse()
  await control.awaitScenarioRequestCount('side_chat_guidance', 2)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'Applied guidance remained in the side-chat queue',
    DEFAULT_STEP_TIMEOUT_MS,
    sideChatSelector
  )

  await control.command('click', '[data-testid="toggle-right-workspace-panel-expanded-button"]')
  await control.command(
    'waitFor',
    `${sideChatSelector} [data-testid="restore-conversation-from-expanded-workspace-button"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('finishAnimations', 'body')
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="project-chat-composer"]`
      )
    ),
    1,
    'Expanded temporary chat rendered more than its own composer'
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-floating-composer-card"]`
      )
    ),
    0,
    'The main task composer remained visible behind the expanded temporary chat'
  )
  await captureVerificationScreenshot(control, '06-side-chat-expanded-single-composer.png')

  await control.command(
    'click',
    `${sideChatSelector} [data-testid="restore-conversation-from-expanded-workspace-button"]`
  )
  await control.command('waitFor', '[data-testid="right-workspace-resize-handle"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('finishAnimations', 'body')
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="project-chat-composer"]`
      )
    ),
    2,
    'Restoring the split view did not restore the two independent composers'
  )
  await captureVerificationScreenshot(control, '07-side-chat-restored-two-composers.png')
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')

  const requests = control.scenarioRequests.get('side_chat_attachment') ?? []
  assert.equal(requests.length, 1, 'The side chat did not send exactly one model request')
  const requestText = JSON.stringify(requests[0].body)
  assert.ok(requestText.includes(SIDE_CHAT_PROMPT), 'The side-chat prompt was not forwarded')
  assert.ok(requestText.includes(SIDE_CHAT_FILENAME), 'The side-chat attachment was not forwarded')
}

export {
  verifyPastedZipAttachment,
  verifySystemDragPanelLayout,
  verifyPastedWorkspacePaths,
  verifyDroppedWorkspacePaths,
  verifySideChatAttachmentIsolation,
}
