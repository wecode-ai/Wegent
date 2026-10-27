import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createOfficePreviewFixtures } from '../modules/office-preview-fixtures.mjs'
import { createLocalProject } from '../modules/streaming-text-fixture.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const COMPOSER =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"] [data-testid="chat-message-input"]'
const VIEWER = '.wework-workspace-file-viewer'
const FILE_TABS = '[role="tab"][data-testid^="right-workspace-file-tab"]'
const EXCEL_STAGE = '.excel-wrapper .e-virt-table-stage'
const EXCEL_LAYER = '.excel-wrapper .excel-image-layer'
const TASK_PROMPT = 'OFFICE_PREVIEW_TASK_'

async function waitForValue(read, predicate, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`${description}: ${JSON.stringify(value)}`)
}

async function metrics(control, selector) {
  return JSON.parse(await control.command('getElementMetrics', selector))
}

async function openFromTree(control, filename) {
  const tree = '[data-testid="workspace-file-tree-pierre"]'
  if (Number(await control.command('getElementCount', tree, { visible: true })) === 0) {
    await control.command('click', '[data-testid="workspace-file-toggle-tree-button"]')
  }
  const item = `button[data-type="item"][aria-label="${filename}"]`
  await control.command('waitFor', item, { visible: true })
  await control.command('click', item)
}

async function assertLastContentVisible(control, scroller, content, timeoutMs) {
  await waitForValue(
    async () => ({
      viewport: (await metrics(control, scroller))[0],
      last: (await metrics(control, content)).at(-1),
    }),
    ({ viewport, last }) =>
      viewport.scrollTop > 0 && last.top >= viewport.top && last.bottom <= viewport.bottom,
    'The last document page must be visible inside the scrolling viewport',
    timeoutMs
  )
}

async function verifyPresentation(control, captureScreenshot, timeoutMs) {
  await openFromTree(control, 'slides.pptx')
  await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 1 OF 8' })
  assert.equal((await metrics(control, VIEWER))[0].scrollTop, 0)
  await control.command('nativePress', VIEWER, { key: 'PageDown' })
  await waitForValue(
    () => metrics(control, VIEWER),
    ([viewport]) => viewport.scrollTop > 0,
    'PageDown must scroll the presentation',
    timeoutMs
  )
  await control.command('scrollToBottomAsUser', VIEWER)
  await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 8 OF 8' })
  assert.equal((await metrics(control, '.pptx-render-surface .slide')).length, 8)
  await assertLastContentVisible(control, VIEWER, '.pptx-render-surface .slide', timeoutMs)
  await captureScreenshot(control, 'office-preview-ppt-last-slide.png')
  await control.command('scrollFromBottomAsUser', VIEWER, { value: '100000' })
  assert.equal((await metrics(control, VIEWER))[0].scrollTop, 0)
}

async function verifyDocument(control, captureScreenshot, timeoutMs) {
  await openFromTree(control, 'document.docx')
  await control.command('waitFor', '.docx-wrapper', { text: 'WORD PARAGRAPH 180' })
  const scroller = `${VIEWER} .file-render`
  await control.command('nativePress', scroller, { key: 'PageDown' })
  await waitForValue(
    () => metrics(control, scroller),
    ([viewport]) => viewport.scrollTop > 0,
    'PageDown must scroll the Word document',
    timeoutMs
  )
  await control.command('scrollToBottomAsUser', scroller)
  await assertLastContentVisible(control, scroller, '.docx-wrapper p', timeoutMs)
  await captureScreenshot(control, 'office-preview-word-last-paragraph.png')
  await control.command('scrollFromBottomAsUser', scroller, { value: '100000' })
  assert.equal((await metrics(control, scroller))[0].scrollTop, 0)
}

async function spreadsheetOffset(control) {
  const style = await control.command('getAttribute', EXCEL_LAYER, { value: 'style' })
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(style)
  assert.ok(match, `Spreadsheet scroll transform is unavailable: ${style}`)
  return { x: -Number(match[1]), y: -Number(match[2]) }
}

async function verifyWorkbook(control, captureScreenshot, timeoutMs) {
  await openFromTree(control, 'workbook.xlsx')
  await control.command('waitFor', '.excel-wrapper .sheet-tab[title="Data"][aria-pressed="true"]')
  await control.command('waitFor', EXCEL_LAYER)
  await control.command('wheel', EXCEL_STAGE, {
    value: JSON.stringify({ deltaX: 800, deltaY: 100000 }),
  })
  await waitForValue(
    () => spreadsheetOffset(control),
    ({ x, y }) => x >= 800 && y > 1000,
    'Excel must handle both horizontal and vertical wheel input',
    timeoutMs
  )
  await captureScreenshot(control, 'office-preview-excel-scrolled.png')
  await control.command('wheel', EXCEL_STAGE, {
    value: JSON.stringify({ deltaX: -100000, deltaY: -100000 }),
  })
  await waitForValue(
    () => spreadsheetOffset(control),
    ({ x, y }) => x === 0 && y === 0,
    'Excel must scroll back to the first row and column',
    timeoutMs
  )
  await control.command('click', '.excel-wrapper .sheet-tab[title="Summary"]')
  await control.command(
    'waitFor',
    '.excel-wrapper .sheet-tab[title="Summary"][aria-pressed="true"]'
  )
  await captureScreenshot(control, 'office-preview-excel-summary.png')
  await control.command('click', '.excel-wrapper .sheet-tab[title="Data"]')
  await control.command('waitFor', '.excel-wrapper .sheet-tab[title="Data"][aria-pressed="true"]')
}

async function verifyOriginalTabRestoration(control, captureScreenshot) {
  await control.command('click', `${FILE_TABS}[title$="slides.pptx"]`)
  await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 1 OF 8' })
  assert.equal(Number(await control.command('getElementCount', '.excel-wrapper')), 0)
  assert.equal(Number(await control.command('getElementCount', FILE_TABS)), 3)
  await captureScreenshot(control, 'office-preview-original-ppt-restored.png')
}

async function createTask(control, name, timeoutMs) {
  await selectE2EModel(control)
  await control.command('fill', COMPOSER, { value: `${TASK_PROMPT}${name}` })
  await control.command('press', COMPOSER, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: `${TASK_PROMPT}${name}_READY`,
    timeoutMs,
  })
  const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  assert.ok(debug.workbench.currentRuntimeTask?.taskId, 'The Office task must really start')
  return debug.workbench.currentRuntimeTask.taskId
}

async function verifyTaskSwitch(control, originalTaskId, captureScreenshot, timeoutMs) {
  await openFromTree(control, 'long-slides.pptx')
  await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 1 OF 32' })
  await control.command('scrollToBottomAsUser', VIEWER)
  await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 32 OF 32' })
  await assertLastContentVisible(control, VIEWER, '.pptx-render-surface .slide', timeoutMs)
  await captureScreenshot(control, 'office-preview-ppt-before-task-switch.png')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', COMPOSER)
  const otherTaskId = await createTask(control, 'B', timeoutMs)
  assert.notEqual(otherTaskId, originalTaskId)
  await control.command('click', `[data-testid="runtime-local-task-row-${originalTaskId}"]`)
  await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 1 OF 32' })
  await control.command('scrollToBottomAsUser', VIEWER)
  await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 32 OF 32' })
  const slides = await metrics(control, '.pptx-render-surface .slide')
  assert.ok(slides.length > 0, 'Returning to the task must restore rendered slides')
  assert.ok(slides[0].width > 0 && slides[0].height > 0, 'Restored slides must have visible size')
  await assertLastContentVisible(control, VIEWER, '.pptx-render-surface .slide', timeoutMs)
  await captureScreenshot(control, 'office-preview-ppt-after-task-switch.png')
}

async function verifyRestoredDirectory(
  control,
  taskId,
  otherTaskId,
  workspacePath,
  captureScreenshot
) {
  await control.command('click', `[data-testid="runtime-local-task-row-${taskId}"]`)
  await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 1 OF 32' })
  await control.command('click', '[data-testid="assistant-markdown-link"][aria-label$="/folders"]')
  const directoryToolbar = '[data-testid="workspace-file-path"][title$="/folders"]'
  await control.command('waitFor', directoryToolbar)
  await control.command('click', `[data-testid="runtime-local-task-row-${otherTaskId}"]`)
  await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 1 OF 8' })
  await control.command('click', `[data-testid="runtime-local-task-row-${taskId}"]`)
  await control.command('waitFor', directoryToolbar)
  const nested = 'button[data-type="item"][aria-label="nested"]'
  await control.command('waitFor', nested)
  await control.command('click', nested)
  await control.command('waitFor', 'button[data-type="item"][aria-label="already-listed.txt"]')
  await writeFile(
    join(workspacePath, 'folders', 'nested', 'refresh-visible.txt'),
    'Directory refresh regression'
  )
  await control.command('click', '[data-testid="workspace-file-refresh-button"]')
  await control.command('waitFor', 'button[data-type="item"][aria-label="refresh-visible.txt"]')
  await captureScreenshot(control, 'office-preview-restored-directory-browsing.png')
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  let runningResponse
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const text = JSON.stringify(body)
      const task = text.includes(`${TASK_PROMPT}RUN`)
        ? 'RUN'
        : text.includes(`${TASK_PROMPT}B`)
          ? 'B'
          : 'A'
      const id = `office-preview-${task}-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (task === 'RUN') {
        response.write(
          createSse([
            responseCreated(id),
            assistantMessage(
              `${TASK_PROMPT}RUN_READY\n\n[Office presentation](${workspacePath}/slides.pptx)`
            ),
          ])
        )
        runningResponse = { response, id }
        return true
      }
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(
            `${TASK_PROMPT}${task}_READY\n\n[Office presentation](${workspacePath}/slides.pptx)\n\n[Office folder](${workspacePath}/folders)`
          ),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      await createOfficePreviewFixtures(workspacePath)
      await createLocalProject(control, workspacePath, uiTimeoutMs)
      const originalTaskId = await createTask(control, 'A', uiTimeoutMs)
      await control.command(
        'click',
        '[data-testid="assistant-markdown-link"][aria-label$="/slides.pptx"]'
      )
      await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 1 OF 8' })
      await verifyPresentation(control, captureScreenshot, uiTimeoutMs)
      await verifyDocument(control, captureScreenshot, uiTimeoutMs)
      await verifyWorkbook(control, captureScreenshot, uiTimeoutMs)
      await verifyOriginalTabRestoration(control, captureScreenshot)
      await verifyTaskSwitch(control, originalTaskId, captureScreenshot, uiTimeoutMs)
      await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
      const runningTaskId = await createTask(control, 'RUN', uiTimeoutMs)
      const runningDebug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      assert.equal(runningDebug.workbench.lifecycleCurrentTaskRunning, true)
      const runningPath = runningDebug.workbench.currentRuntimeTask.workspacePath
      assert.ok(runningPath, 'A standalone task must own a workspace')
      await control.command(
        'click',
        '[data-testid="assistant-markdown-link"][aria-label$="/slides.pptx"]'
      )
      await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 1 OF 8' })
      await verifyPresentation(control, captureScreenshot, uiTimeoutMs)
      await control.command('click', `[data-testid="runtime-local-task-row-${originalTaskId}"]`)
      await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 1 OF 32' })
      await control.command('click', `[data-testid="runtime-local-task-row-${runningTaskId}"]`)
      await control.command('waitFor', '[data-testid="workspace-file-toolbar"]')
      await control.command('waitFor', '.pptx-render-surface', { text: 'PPT PAGE 1 OF 8' })
      await verifyPresentation(control, captureScreenshot, uiTimeoutMs)
      await captureScreenshot(control, 'office-preview-running-task-restored.png')
      await verifyRestoredDirectory(
        control,
        originalTaskId,
        runningTaskId,
        workspacePath,
        captureScreenshot
      )
      assert.ok(runningResponse, 'The standalone task response must remain active')
      runningResponse.response.end(createSse([responseCompleted(runningResponse.id)]))
    },
  }
}
