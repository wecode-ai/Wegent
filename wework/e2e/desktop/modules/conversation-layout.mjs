import { sendPrompt } from './conversation-navigation.mjs'

import { ensureTaskRowVisible, waitForScenarioRequestCount } from './memory-tool-flows.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  COMPOSER_READY_STABILITY_MS,
  CONVERSATION_SWITCH_RACE_PROMPT,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  FRESH_CHAT_COMPLETION_TEXT,
  FRESH_CHAT_PROMPT,
  SHORT_CONVERSATION_MAX_MESSAGE_TOP_OFFSET,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  createSingleRootLocalProject,
  join,
  pathExists,
  resultDir,
  selectE2EModel,
  withTimeout,
  writeFile,
} from './shared.mjs'

import { captureVerificationScreenshot } from './workspace-flows.mjs'

async function verifyShortConversationLayout({ composerSelector, control }) {
  const taskRowsBeforeConversation = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await prepareCompletedTurnScreenshot(control)
  await captureVerificationScreenshot(control, 'short-conversation-00-ready.png')
  await control.command('fill', composerSelector, { value: FRESH_CHAT_PROMPT })
  await control.command('waitFor', composerSelector, {
    text: FRESH_CHAT_PROMPT,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'short-conversation-01-prompt-filled.png')
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FRESH_CHAT_COMPLETION_TEXT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await sendPrompt(control, composerSelector, `${FRESH_CHAT_PROMPT} FOLLOW_UP`)
  await waitForScenarioRequestCount(control, 'fresh_chat', 2)
  await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const shortConversationTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeConversation,
    'WEWORK_DESKTOP_E2E_FRESH_CHAT'
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('clickWhenEnabled', `[data-testid="${shortConversationTaskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FRESH_CHAT_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const scroller = await getSingleElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll"]`,
    'The short conversation message scroller'
  )
  const userMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  const assistantMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
  )
  const virtualRows = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"] [data-index]`
  )
  assert.equal(userMessages.length, 2, 'The short conversation did not render both user messages')
  assert.equal(
    assistantMessages.length,
    2,
    'The reopened short conversation did not render both assistant messages'
  )
  assert.equal(
    virtualRows.length,
    4,
    'The unified virtual list did not mount every short-conversation turn'
  )
  assert.equal(
    await control.command(
      'getStyle',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"] [data-index]`,
      { value: 'position' }
    ),
    'absolute',
    'Short conversations did not use the unified virtual row layout'
  )
  const conversationSnapshot = JSON.parse(
    await control.command(
      'snapshot',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
    )
  )
  assert.ok(
    countTextOccurrences(conversationSnapshot.text, FRESH_CHAT_PROMPT) >= 2,
    'The reopened virtualized conversation lost an earlier user message'
  )
  assert.ok(
    countTextOccurrences(conversationSnapshot.text, FRESH_CHAT_COMPLETION_TEXT) >= 2,
    'The reopened virtualized conversation lost an earlier assistant message'
  )
  const firstMessage = userMessages[0]
  const messageTopOffset = firstMessage.top - scroller.top
  await writeFile(
    join(resultDir, 'short-conversation-layout-metrics.json'),
    `${JSON.stringify(
      {
        assistantMessages,
        firstMessage,
        messageTopOffset,
        scroller,
        userMessages,
        virtualRows,
      },
      null,
      2
    )}\n`
  )
  await captureVerificationScreenshot(control, 'short-conversation-02-completed-top-aligned.png')

  assert.ok(
    messageTopOffset >= 0,
    'The first short-conversation message rendered above the viewport'
  )
  assert.ok(
    messageTopOffset <= SHORT_CONVERSATION_MAX_MESSAGE_TOP_OFFSET,
    `The short conversation left ${messageTopOffset}px of blank space above its first message`
  )

  const taskRowsBeforeRace = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  const concurrentRequestCount = control.scenarioRequests.get('concurrent_memory')?.length ?? 0
  control.setScenario('concurrent_memory')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await sendPrompt(control, composerSelector, CONVERSATION_SWITCH_RACE_PROMPT)
  await control.awaitScenarioRequestCount('concurrent_memory', concurrentRequestCount + 1)
  const runningTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeRace,
    'WEWORK_DESKTOP_E2E_CONCURRENT_MEMORY_1'
  )

  await ensureTaskRowVisible(control, shortConversationTaskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${shortConversationTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FRESH_CHAT_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  await ensureTaskRowVisible(control, runningTaskRowTestId)
  await control.command('clickThenMacrotask', `[data-testid="${runningTaskRowTestId}"]`, {
    target: `[data-testid="${shortConversationTaskRowTestId}"]`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FRESH_CHAT_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const restoredAfterRace = JSON.parse(
    await control.command(
      'snapshot',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
    )
  )
  assert.ok(
    countTextOccurrences(restoredAfterRace.text, FRESH_CHAT_PROMPT) >= 2,
    'Rapid conversation switching lost an earlier user message'
  )
  assert.ok(
    countTextOccurrences(restoredAfterRace.text, FRESH_CHAT_COMPLETION_TEXT) >= 2,
    'Rapid conversation switching lost an earlier assistant message'
  )
  await captureVerificationScreenshot(control, 'short-conversation-03-rapid-switch-restored.png')
  control.releaseConcurrentMemoryResponses()
  const runningTaskId = runningTaskRowTestId.replace('runtime-local-task-row-', '')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(`runtime-local-task-running-${runningTaskId}`),
    'The rapid-switch background task did not settle after its response was released'
  )
  const settledAfterRace = JSON.parse(
    await control.command(
      'snapshot',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
    )
  )
  assert.ok(
    countTextOccurrences(settledAfterRace.text, FRESH_CHAT_PROMPT) >= 2,
    'The settled rapid switch lost an earlier user message'
  )
  assert.ok(
    countTextOccurrences(settledAfterRace.text, FRESH_CHAT_COMPLETION_TEXT) >= 2,
    'The settled rapid switch lost an earlier assistant message'
  )
  assert.equal(
    settledAfterRace.text.includes(CONVERSATION_SWITCH_RACE_PROMPT),
    false,
    'The late background transcript leaked into the restored conversation'
  )
  control.setScenario('fresh_chat')
  return shortConversationTaskRowTestId
}

function countTextOccurrences(value, search) {
  if (!search) return 0
  let count = 0
  let offset = 0
  while (true) {
    const index = value.indexOf(search, offset)
    if (index === -1) return count
    count += 1
    offset = index + search.length
  }
}

async function prepareCompletedTurnScreenshot(control) {
  await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const startedAt = Date.now()
  let menuClosedAt = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (snapshot.testIds.includes('model-selector-menu')) {
      menuClosedAt = null
      await control.command('pointerDown', ACTIVE_COMPOSER_SELECTOR)
    } else {
      menuClosedAt ??= Date.now()
      if (Date.now() - menuClosedAt >= COMPOSER_READY_STABILITY_MS) return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('The model selector menu remained open before the verification screenshot')
}

async function waitForSnapshot(
  control,
  predicate,
  message,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  selector = 'body'
) {
  const startedAt = Date.now()
  let lastSnapshot = null
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', selector))
    lastSnapshot = snapshot
    if (predicate(snapshot)) return snapshot
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  const relevantTestIds = (lastSnapshot?.testIds ?? []).filter(
    testId =>
      testId.startsWith('runtime-local-task-') ||
      testId.startsWith('composer-plugin-') ||
      testId.startsWith('plugin-trial-') ||
      testId.startsWith('workspace-') ||
      testId.startsWith('bottom-workspace-') ||
      [
        'goal-status-bar',
        'pause-response-button',
        'send-message-button',
        'thinking-indicator',
      ].includes(testId)
  )
  throw new Error(`${message}; relevant test IDs: ${JSON.stringify(relevantTestIds)}`)
}

async function openComposerPluginPicker(control) {
  const before = JSON.parse(await control.command('snapshot', 'body'))
  if (before.testIds.includes('composer-plugin-picker')) return
  await control.command('click', '[data-testid="composer-plugin-picker-button"]')
  await control.command('waitFor', '[data-testid="composer-plugin-picker"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function closeComposerPluginPicker(control) {
  const open = JSON.parse(await control.command('snapshot', 'body'))
  if (!open.testIds.includes('composer-plugin-picker')) return
  await control.command('press', 'body', { key: 'Escape' })
  const stillOpen = await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('composer-plugin-picker'),
    'Closing the composer plugin picker did not dismiss the menu',
    DEFAULT_STEP_TIMEOUT_MS
  ).catch(() => null)
  if (stillOpen) return
  await control.command('click', '[data-testid="composer-plugin-picker-button"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('composer-plugin-picker'),
    'Closing the composer plugin picker did not dismiss the menu'
  )
}

/**
 * Install → skills-changed can leave the picker empty briefly while listLocalApps
 * refreshes. Warm via slash autocomplete, reopen the picker, then search.
 */
async function waitForInstalledComposerPlugin(control, { pluginName, pluginDisplayName }) {
  const itemTestId = `composer-plugin-picker-item-plugin:${pluginName}`
  const slashOptionSelector = `[data-testid="slash-command-option-app-plugin-${pluginName}"]`
  const deadline = Date.now() + WORKBENCH_READY_TIMEOUT_MS
  const attemptBudgetMs = 3_000

  while (Date.now() < deadline) {
    await openComposerPluginPicker(control)

    // Prefer an already-warmed list before searching (search can hide a late paint).
    const alreadyVisible = JSON.parse(
      await control.command('snapshot', '[data-testid="composer-plugin-picker"]')
    )
    if (alreadyVisible.testIds.includes(itemTestId)) {
      return itemTestId
    }

    await control.command('fill', '[data-testid="composer-plugin-picker-search"]', {
      value: pluginDisplayName,
    })
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    const matched = await waitForSnapshot(
      control,
      snapshot => snapshot.testIds.includes(itemTestId),
      'waiting for composer plugin picker item',
      Math.min(attemptBudgetMs, remainingMs),
      '[data-testid="composer-plugin-picker"]'
    ).catch(() => null)
    if (matched) return itemTestId

    await closeComposerPluginPicker(control)

    // Warm listLocalApps through the slash menu, which shares the same apps source.
    const warmBudget = Math.min(attemptBudgetMs, deadline - Date.now())
    if (warmBudget > 0) {
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
        value: `/${pluginName.slice(0, 8)}`,
      })
      await control
        .command('waitFor', slashOptionSelector, {
          timeoutMs: warmBudget,
        })
        .catch(() => null)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: '' })
    }

    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }

  await openComposerPluginPicker(control)
  await control.command('fill', '[data-testid="composer-plugin-picker-search"]', {
    value: pluginDisplayName,
  })
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes(itemTestId),
    'The installed plugin did not appear in the composer plugin picker',
    DEFAULT_STEP_TIMEOUT_MS,
    '[data-testid="composer-plugin-picker"]'
  )
  return itemTestId
}

async function assertMentionRenderedAsToken(
  control,
  { tokenSelector, tokenText, plainTextMention, errorLabel }
) {
  await control.command('waitFor', tokenSelector, {
    ...(tokenText ? { text: tokenText } : {}),
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const userMessageText = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  assert.equal(userMessageText.includes(plainTextMention), false, errorLabel)
}

async function getElementMetrics(control, selector) {
  return JSON.parse(await control.command('getElementMetrics', selector))
}

async function getSingleElementMetrics(control, selector, description) {
  const metrics = await getElementMetrics(control, selector)
  assert.equal(metrics.length, 1, `${description} rendered ${metrics.length} matching elements`)
  return metrics[0]
}

async function assertDesktopComposerDocked(control, scrollerMetrics, description) {
  const composerMetrics = await getSingleElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-floating-composer-card"]`,
    description
  )
  assert.ok(
    composerMetrics.top >= scrollerMetrics.top && composerMetrics.bottom <= scrollerMetrics.bottom,
    `${description} was outside the conversation viewport`
  )
  const bottomGap = scrollerMetrics.bottom - composerMetrics.bottom
  assert.ok(
    bottomGap >= 0 && bottomGap <= 32,
    `${description} drifted ${bottomGap}px above the conversation viewport bottom`
  )
}

async function waitForBottomMetrics(control, selector, description, timeoutMs = 1_500) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, selector, description)
    if (distanceFromBottom(metrics) <= 2) return metrics
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(
    `${description} remained ${distanceFromBottom(metrics)}px from the bottom after ${timeoutMs}ms`
  )
}

async function waitForOverflowMetrics(control, selector, description, timeoutMs = 3_000) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, selector, description)
    if (metrics.scrollHeight > metrics.clientHeight) return metrics
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`${description} after ${timeoutMs}ms: ${JSON.stringify(metrics)}`)
}

async function waitForElementInsideScroller(
  control,
  elementSelector,
  scrollerSelector,
  description,
  timeoutMs = 3_000
) {
  const startedAt = Date.now()
  let element
  let scroller
  while (Date.now() - startedAt < timeoutMs) {
    scroller = await getSingleElementMetrics(control, scrollerSelector, description)
    element = (await getElementMetrics(control, elementSelector)).at(-1)
    if (element && element.top >= scroller.top - 2 && element.bottom <= scroller.bottom + 2) {
      return { element, scroller }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`${description} after ${timeoutMs}ms: ${JSON.stringify({ element, scroller })}`)
}

async function waitForTopMetrics(control, selector, description, timeoutMs = 3_000) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, selector, description)
    if (metrics.scrollTop <= 2) return metrics
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(
    `${description} remained ${metrics.scrollTop}px from the top after ${timeoutMs}ms`
  )
}

async function waitForElementWidth(control, selector, predicate, description, timeoutMs = 1_500) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, selector, description)
    if (predicate(metrics.width)) return metrics
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`${description} remained ${metrics.width}px wide after ${timeoutMs}ms`)
}

async function waitForProcessingBlock(
  control,
  selector,
  description,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const startedAt = Date.now()
  let diagnostics = null

  while (Date.now() - startedAt < timeoutMs) {
    await control.command('expandProcessingSummaries', 'body')
    const targetCount = Number(await control.command('getElementCount', selector))
    diagnostics = {
      targetCount,
      finalProcessingExpandedCount: Number(
        await control.command(
          'getElementCount',
          '[data-testid="final-processing-toggle"][aria-expanded="true"]'
        )
      ),
      finalProcessingCollapsedCount: Number(
        await control.command(
          'getElementCount',
          '[data-testid="final-processing-toggle"][aria-expanded="false"]'
        )
      ),
      processingSummaryExpandedCount: Number(
        await control.command(
          'getElementCount',
          '[data-testid="processing-summary-toggle"][aria-expanded="true"]'
        )
      ),
      processingSummaryCollapsedCount: Number(
        await control.command(
          'getElementCount',
          '[data-testid="processing-summary-toggle"][aria-expanded="false"]'
        )
      ),
      processingBlockCount: Number(
        await control.command('getElementCount', '[data-processing-block-id]')
      ),
      processingLivePreviewCount: Number(
        await control.command('getElementCount', '[data-testid="processing-live-preview"]')
      ),
    }
    if (targetCount > 0) return diagnostics
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }

  const snapshot = await control.command('snapshot', 'body')
  await writeFile(
    join(resultDir, 'processing-block-timeout-diagnostics.json'),
    `${JSON.stringify({ description, selector, diagnostics, snapshot: JSON.parse(snapshot) }, null, 2)}\n`,
    'utf8'
  )
  throw new Error(
    `${description} did not render ${selector}; diagnostics: ${JSON.stringify(diagnostics)}`
  )
}

async function verifyViewImageProcessingBlock(control) {
  const viewImageBlockSelector = '[data-processing-block-id="wework-e2e-view-image"]'
  await waitForProcessingBlock(control, viewImageBlockSelector, 'The view_image processing block')
  const generatedImageGalleryCount = Number(
    await control.command('getElementCount', '[data-testid="generated-image-gallery"]')
  )
  assert.equal(
    generatedImageGalleryCount,
    0,
    'The view_image result incorrectly rendered as a final generated-image artifact'
  )
  await control.command('scrollIntoView', '[data-testid="processing-live-preview"]')
  await control.command(
    'waitFor',
    '[data-processing-block-id="wework-e2e-view-image"] [data-tool-detail-toggle][aria-expanded="false"]',
    { visible: true, stableMs: 300, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  await captureVerificationScreenshot(
    control,
    '03-view-image-collapsed.png',
    '[data-testid="processing-live-preview"]'
  )
  await control.command(
    'click',
    '[data-processing-block-id="wework-e2e-view-image"] [data-tool-detail-toggle]'
  )
  await control.command('waitFor', '[data-testid="image-view-preview"]', {
    stableMs: 500,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    '[data-processing-block-id="wework-e2e-view-image"] [data-tool-detail-toggle][aria-expanded="true"]',
    { stableMs: 500, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('scrollIntoView', '[data-testid="processing-live-preview"]')
  await control.command('waitFor', '[data-testid="image-view-preview"]', {
    visible: true,
    stableMs: 500,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  await captureVerificationScreenshot(
    control,
    '04-view-image-expanded.png',
    '[data-testid="processing-live-preview"]'
  )
}

function distanceFromBottom(metrics) {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop)
}

async function openBottomWorkspaceTerminal(control, description) {
  await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
  const snapshot = await waitForSnapshot(
    control,
    value =>
      value.testIds.includes('workspace-terminal-window') &&
      value.testIds.includes('remote-terminal') &&
      !value.testIds.includes('workspace-tool-launcher'),
    `${description} did not start the terminal directly`,
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(
    snapshot.testIds.includes('workspace-ide-card'),
    false,
    `${description} exposed IDE in the bottom panel`
  )
  return snapshot
}

async function closeBottomWorkspacePanel(control) {
  await control.command('click', '[data-testid="close-bottom-workspace-panel-button"]')
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes('workspace-tool-launcher') &&
      !value.testIds.includes('workspace-terminal-window'),
    'The bottom workspace panel did not close',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
}

function processGroup(snapshot, groupName) {
  return snapshot.processMemory.groups.find(group => group.group === groupName) ?? null
}

async function captureMemorySample(control, phase) {
  const snapshot = JSON.parse(await control.command('performanceSnapshot', 'body'))
  const webContent = processGroup(snapshot, 'webkit-webcontent')
  assert.ok(webContent, 'The Wework WebContent process was missing from the memory snapshot')
  return {
    phase,
    timestamp: snapshot.timestamp,
    domNodeCount: snapshot.domNodeCount,
    rssKiB: webContent.rss_kib,
    physicalFootprintKiB: webContent.physical_footprint_kib,
    pids: webContent.pids,
  }
}

async function captureTotalMemorySample(control, phase) {
  const snapshot = JSON.parse(await control.command('performanceSnapshot', 'body'))
  return {
    phase,
    timestamp: snapshot.timestamp,
    domNodeCount: snapshot.domNodeCount,
    rssKiB: snapshot.processMemory.groups.reduce((total, group) => total + group.rss_kib, 0),
    physicalFootprintKiB: snapshot.processMemory.groups.reduce(
      (total, group) => total + group.physical_footprint_kib,
      0
    ),
    groups: snapshot.processMemory.groups,
  }
}

async function waitForNewTaskRow(
  control,
  knownTaskRows,
  expectedText,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const candidates = snapshot.testIds.filter(
      testId => testId.startsWith('runtime-local-task-row-') && !knownTaskRows.has(testId)
    )
    for (const testId of candidates) {
      const rowText = await control.command('getText', `[data-testid="${testId}"]`)
      if (rowText.includes(expectedText)) return testId
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`The sidebar did not expose a task row for ${expectedText}`)
}

async function createCheckpointTaskFixture(control, composerSelector) {
  const knownTaskRows = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  control.setScenario('checkpoint_task')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await sendPrompt(control, composerSelector, CHECKPOINT_TASK_PROMPT)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CHECKPOINT_TASK_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  return waitForNewTaskRow(control, knownTaskRows, 'WEWORK_DESKTOP_E2E_CHECKPOINT_TASK')
}

async function verifyWorktreeCreationStatus({ composerSelector, control, workspacePath }) {
  const projectMenusBeforeCreate = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('project-menu-')
    )
  )
  await createSingleRootLocalProject(control, workspacePath, 'worktree-status')
  const projectSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.some(
        testId => testId.startsWith('project-menu-') && !projectMenusBeforeCreate.has(testId)
      ),
    'The worktree status fixture project was not shown in the sidebar'
  )
  const projectMenuTestId = projectSnapshot.testIds.find(
    testId => testId.startsWith('project-menu-') && !projectMenusBeforeCreate.has(testId)
  )
  assert.ok(projectMenuTestId, 'The worktree status fixture project identity was not found')
  const projectId = projectMenuTestId.slice('project-menu-'.length)

  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await captureVerificationScreenshot(control, 'worktree-status-01-project-ready.png')

  await control.command('click', '[data-testid="execution-mode-button"]')
  await control.command('click', '[data-testid="execution-mode-git-worktree-button"]')
  await control.command('waitFor', '[data-testid="execution-mode-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.match(
    await control.command('getText', '[data-testid="execution-mode-button"]'),
    /新工作树|New worktree/,
    'The composer did not switch to worktree execution mode'
  )
  await captureVerificationScreenshot(control, 'worktree-status-02-mode-selected.png')

  control.setScenario('checkpoint_task')
  const scenarioRequest = control.awaitScenarioRequest('checkpoint_task')
  await sendPrompt(control, composerSelector, CHECKPOINT_TASK_PROMPT)
  await control.command('waitFor', '[data-testid="worktree-creation-status"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.match(
    await control.command('getText', '[data-testid="worktree-creation-status"]'),
    /正在搭建你的独立工作树|Building your independent worktree/,
    'The worktree creation status page did not explain the active operation'
  )
  await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`, {
    text: CHECKPOINT_TASK_PROMPT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const creatingSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    creatingSnapshot.testIds.includes('desktop-floating-composer-card'),
    false,
    'The composer remained interactive while the worktree was being created'
  )
  await captureVerificationScreenshot(control, 'worktree-status-03-creating.png')

  await withTimeout(
    scenarioRequest,
    DEFAULT_STEP_TIMEOUT_MS,
    'The worktree task did not reach the model service after creation'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CHECKPOINT_TASK_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'worktree-status-04-task-started.png')

  const taskDebugSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const worktreeTaskId = taskDebugSnapshot.workbench?.currentRuntimeTask?.taskId
  const worktreePath = taskDebugSnapshot.workbench?.currentRuntimeTask?.workspacePath
  assert.ok(worktreeTaskId, 'The worktree task did not expose its runtime task ID')
  assert.ok(worktreePath, 'The worktree task did not expose its workspace path')
  const worktreeContainer = join(worktreePath, '..')
  assert.equal(await pathExists(worktreePath), true, 'The managed worktree was not created')
  assert.equal(
    await pathExists(worktreeContainer),
    true,
    'The managed worktree container was not created'
  )
  await control.command('waitFor', composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  await control.command('click', `[data-testid="runtime-local-task-archive-${worktreeTaskId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="runtime-local-task-archive-toast-${worktreeTaskId}"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await withTimeout(
    (async () => {
      while ((await pathExists(worktreePath)) || (await pathExists(worktreeContainer))) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
      }
    })(),
    DEFAULT_STEP_TIMEOUT_MS,
    'Archiving the worktree task left its repository or runtime container on disk'
  )
}

export {
  verifyShortConversationLayout,
  countTextOccurrences,
  prepareCompletedTurnScreenshot,
  waitForSnapshot,
  openComposerPluginPicker,
  closeComposerPluginPicker,
  waitForInstalledComposerPlugin,
  assertMentionRenderedAsToken,
  getElementMetrics,
  getSingleElementMetrics,
  assertDesktopComposerDocked,
  waitForBottomMetrics,
  waitForOverflowMetrics,
  waitForElementInsideScroller,
  waitForTopMetrics,
  waitForElementWidth,
  waitForProcessingBlock,
  verifyViewImageProcessingBlock,
  distanceFromBottom,
  openBottomWorkspaceTerminal,
  closeBottomWorkspacePanel,
  processGroup,
  captureMemorySample,
  captureTotalMemorySample,
  waitForNewTaskRow,
  createCheckpointTaskFixture,
  verifyWorktreeCreationStatus,
}
