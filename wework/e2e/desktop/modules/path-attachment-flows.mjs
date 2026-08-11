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
  SIDE_CHAT_PROMPT,
  SIDE_CHAT_QUEUE_FOLLOW_UP,
  SIDE_CHAT_QUEUE_INITIAL,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  mkdir,
  pathToFileURL,
  resultDir,
  writeFile,
} from './shared.mjs'

import { captureVerificationScreenshot } from './workspace-flows.mjs'

async function verifyPastedZipAttachment({ composerSelector, control }) {
  control.setScenario('pasted_zip_attachment')
  await control.command('snapshot', 'body')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('pasteFile', composerSelector, {
    filename: PASTED_ZIP_FILENAME,
    mimeType: 'application/zip',
    value: PASTED_ZIP_BASE64,
  })
  await control.command('waitFor', '[data-testid="attachment-badge"]', {
    text: PASTED_ZIP_FILENAME,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
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
  await captureVerificationScreenshot(
    control,
    'system-drag-panel.png',
    '[data-testid="system-drag-panel"]'
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

async function verifyPastedWorkspacePaths({ composerSelector, control, workspacePath }) {
  control.setScenario('pasted_workspace_paths')
  const folderPath = join(workspacePath, PASTED_PATH_FOLDER_NAME)
  const filePath = join(workspacePath, PASTED_PATH_FILE_NAME)
  await mkdir(folderPath, { recursive: true })
  await writeFile(join(folderPath, 'nested.txt'), 'nested path context\n')
  await writeFile(filePath, '# Pasted path context\n')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
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
  await control.command('waitFor', '[data-testid="composer-path-chip-pasted-context-md"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    snapshot.testIds.includes('attachment-badge'),
    false,
    'Pasted local paths were copied into attachment uploads'
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
}

async function verifyDroppedWorkspacePaths({ composerSelector, control, workspacePath }) {
  control.setScenario('dropped_workspace_paths')
  const folderPath = join(workspacePath, DROPPED_PATH_FOLDER_NAME)
  const filePath = join(workspacePath, DROPPED_PATH_FILE_NAME)
  await mkdir(folderPath, { recursive: true })
  await writeFile(join(folderPath, 'nested.txt'), 'nested dropped path context\n')
  await writeFile(filePath, '# Dropped path context\n')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
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
  await control.command('waitFor', '[data-testid="composer-path-chip-dropped-context-md"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    snapshot.testIds.includes('attachment-badge'),
    false,
    'Dropped local paths were copied into attachment uploads'
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

  control.setScenario('side_chat_queue')
  await control.command('fill', sideComposerSelector, { value: SIDE_CHAT_QUEUE_INITIAL })
  await control.command('click', `${sideChatSelector} [data-testid="send-message-button"]`)
  await control.awaitScenarioRequestCount('side_chat_queue', 1)
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
  control.releaseSideChatQueueResponse()

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
  await captureVerificationScreenshot(control, '05-side-chat-expanded-single-composer.png')

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
  await captureVerificationScreenshot(control, '05-side-chat-restored-two-composers.png')
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
