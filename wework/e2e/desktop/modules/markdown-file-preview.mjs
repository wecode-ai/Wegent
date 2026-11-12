import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ACTIVE_SEND_BUTTON_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_DEVICE_ID,
  CLOUD_HTML_LINK_FILENAME,
  CLOUD_HTML_LINK_PROMPT,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  selectE2EModel,
  withTimeout,
} from './shared.mjs'

export async function assertMarkdownPreviewAndSource(control, text, options = {}) {
  await control.command('waitFor', '[data-testid="workspace-markdown-preview"]', {
    ...options,
    text,
  })
  await control.command('clickWhenEnabled', '[data-testid="workspace-file-markdown-mode-button"]')
  await control.command('waitFor', '[data-testid="workspace-file-editor-content"]', {
    ...options,
    text,
  })
}

const CLOUD_HTML_RENDERED_MARKER = 'WEWORK_CLOUD_HTML_LINK_RENDERED'
const CLOUD_HTML_SOURCE_MARKER = 'WEWORK_CLOUD_HTML_LINK_SOURCE'

function normalizedPath(path) {
  return path.replaceAll('\\', '/')
}

export async function verifyCloudHtmlFileLinkPreview({
  composerSelector,
  control,
  projectRowSelector,
  workspacePath,
}) {
  const previewPath = normalizedPath(join(workspacePath, CLOUD_HTML_LINK_FILENAME))
  await writeFile(
    previewPath,
    [
      '<!doctype html>',
      '<html lang="en"><body>',
      `<h1 data-testid="cloud-html-link-rendered">${CLOUD_HTML_RENDERED_MARKER}</h1>`,
      `<!--${CLOUD_HTML_SOURCE_MARKER}-->`,
      '</body></html>',
    ].join('\n')
  )

  await control.command(
    'clickWhenEnabled',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)

  control.setScenario('cloud_html_link')
  await control.command('fill', composerSelector, { value: CLOUD_HTML_LINK_PROMPT })
  await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR)
  await withTimeout(
    control.awaitScenarioRequestCount('cloud_html_link', 1),
    WORKBENCH_READY_TIMEOUT_MS,
    'The Cloud executor did not request the HTML link response'
  )

  const links = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-testid="assistant-markdown-link"]`
  await control.command('waitFor', links, {
    text: 'Cloud HTML preview',
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`,
    { visible: false }
  )

  const taskSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const taskAddress =
    taskSnapshot.pane?.currentRuntimeTask ?? taskSnapshot.workbench?.currentRuntimeTask
  assert.equal(
    taskAddress?.deviceId,
    CLOUD_DEVICE_ID,
    'The HTML link was opened outside the owning Cloud task'
  )
  assert.equal(
    taskAddress?.workspacePath,
    workspacePath,
    'The HTML link task did not use the Cloud project workspace'
  )

  const panel = `[data-testid="workspace-file-panel"][data-workspace-device-id=${JSON.stringify(
    CLOUD_DEVICE_ID
  )}]`
  const preview = `${panel} [data-testid="workspace-html-file-preview"]`
  const frame = `${preview} iframe`

  await control.command('clickElementWithText', links, { text: 'Cloud HTML preview' })
  await control.command('waitFor', panel, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('waitFor', preview, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  assert.equal(
    await control.command('getText', `${panel} [data-testid="workspace-file-path"]`),
    previewPath,
    'The Cloud HTML link did not open the file from its owning device'
  )
  assert.match(
    await control.command('getAttribute', frame, { value: 'srcdoc' }),
    new RegExp(CLOUD_HTML_RENDERED_MARKER),
    'The Cloud HTML file did not render its document content'
  )
  assert.equal(
    Number(
      await control.command('getElementCount', '[data-testid="workspace-browser-panel"]', {
        visible: true,
      })
    ),
    0,
    'The Cloud HTML link opened the embedded browser instead of the Files panel'
  )

  const modeButton = `${panel} [data-testid="workspace-file-markdown-mode-button"]`
  await control.command('clickWhenEnabled', modeButton)
  await control.command('waitFor', `${panel} [data-testid="workspace-file-editor-content"]`, {
    text: CLOUD_HTML_SOURCE_MARKER,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    Number(await control.command('getElementCount', preview, { visible: true })),
    0,
    'Switching to source left the rendered Cloud HTML preview mounted'
  )

  await control.command('clickWhenEnabled', modeButton)
  await control.command('waitFor', preview, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.match(
    await control.command('getAttribute', frame, { value: 'srcdoc' }),
    new RegExp(CLOUD_HTML_RENDERED_MARKER),
    'Switching back from source did not restore the rendered Cloud HTML'
  )

  await control.command('clickElementWithText', links, { text: 'Missing Cloud HTML' })
  const previewError = `${panel} [data-testid="workspace-file-preview-error"]`
  await control.command('waitFor', previewError, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  assert.match(
    await control.command('getText', previewError),
    /Failed|失败/,
    'A missing Cloud HTML file did not surface the device read failure'
  )
  await control.command('waitFor', `${panel} [data-testid="workspace-file-preview-retry-button"]`)

  await control.command('clickElementWithText', links, { text: 'Cloud HTML preview' })
  await control.command('waitFor', preview, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.match(
    await control.command('getAttribute', frame, { value: 'srcdoc' }),
    new RegExp(CLOUD_HTML_RENDERED_MARKER),
    'The Files panel did not recover after a failed Cloud HTML read'
  )
}
