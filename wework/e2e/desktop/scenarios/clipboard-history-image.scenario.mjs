import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { openProjectBoard } from '../modules/collaboration-board-personal-view.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const CHAT = `${CONTENT} [data-testid="project-space-chat-panel"]`
const CHAT_COMPOSER = `${CHAT} [data-testid="chat-message-input"]`
const CREATE_ISSUE = `${CONTENT} [data-testid="collaboration-issue-create"]`
const CREATE_DIALOG = `${CONTENT} [data-testid="collaboration-issue-create-dialog"]`
const CREATE_PANEL = `${CREATE_DIALOG} [data-testid="cloud-todo-create-panel"]`
const CREATE_TITLE = `${CREATE_DIALOG} [data-testid="cloud-todo-title"]`
const CREATE_DESCRIPTION = `${CREATE_DIALOG} [data-testid="cloud-todo-detail-description"]`
const PROJECT_NAME = `Clipboard history images ${process.pid}`
const ISSUE_TITLE = 'Clipboard history image conversion'
const CHAT_IMAGE = 'clipboard-chat.tiff'
const ISSUE_IMAGE = 'clipboard-issue.tiff'
const BROKEN_IMAGE = 'clipboard-broken.tiff'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TIFF_FIXTURE = JSON.parse(
  await readFile(new URL('../fixtures/clipboard-history-image.json', import.meta.url), 'utf8')
)

function replaceClipboardWithText(value) {
  const result = spawnSync('/usr/bin/pbcopy', [], { input: value, encoding: 'utf8' })
  assert.equal(result.status, 0, `pbcopy failed: ${result.stderr}`)
}

async function waitFor(condition, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await condition()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(message)
}

async function waitForDecodedImage(control, selector, timeoutMs) {
  return waitFor(
    async () => {
      const [state] = JSON.parse(await control.command('getImageLoadState', selector))
      return state?.complete &&
        state.naturalWidth === TIFF_FIXTURE.width &&
        state.naturalHeight === TIFF_FIXTURE.height
        ? state
        : null
    },
    `${selector} did not decode as ${TIFF_FIXTURE.width}x${TIFF_FIXTURE.height}`,
    timeoutMs
  )
}

async function waitForStagedFile(executorHome, filename, timeoutMs) {
  return waitFor(
    async () => {
      const root = join(executorHome, 'workspace', 'attachments', 'draft')
      const files = await readdir(root, { recursive: true }).catch(() => [])
      const path = files.map(entry => join(root, entry)).find(entry => basename(entry) === filename)
      return path ?? null
    },
    `The converted ${filename} file was not staged`,
    timeoutMs
  )
}

function pngDimensions(bytes) {
  assert.equal(bytes.subarray(0, 8).equals(PNG_SIGNATURE), true, 'Persisted attachment is not PNG')
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

export function createDesktopScenario({ executorHome, uiTimeoutMs, workspacePath }) {
  return {
    async verify(control) {
      if (process.platform !== 'darwin') {
        console.log('[desktop-e2e] Clipboard-history TIFF conversion is covered on macOS')
        return { skipped: 'macos-only' }
      }

      // In the failed run (07:17:14.942 UTC), executor.log records project import
      // succeeding at 07:18:49.752. In app.log, Chromium restarted its network
      // service at 07:18:53.785 and the renderer's RPC and event requests aborted.
      // The sidebar lookup then failed before any paste (see failure.txt).
      // https://github.com/wecode-ai/Wegent/actions/runs/43382146308/artifacts/14018626553
      // Project import has its own checkpoint; seed through the local Executor.
      const projectKey = `clipboard-history-image-${process.pid}`
      const projectId = `local-code-${createHash('sha256').update(projectKey).digest('hex')}`
      const seeded = JSON.parse(
        await control.command('seedLocalProject', 'body', {
          value: JSON.stringify({ projectKey, name: PROJECT_NAME, path: workspacePath }),
        })
      )
      assert.equal(seeded.accepted, true)
      await ensureExperimentalFeaturesEnabled(control)
      await openProjectBoard(control, selector => `${CONTENT} ${selector}`.trim(), {
        id: projectId,
        name: PROJECT_NAME,
      })

      await control.command(
        'clickWhenEnabled',
        `${CONTENT} [data-testid="project-space-chat-open"]`
      )
      await control.command('waitFor', CHAT)
      replaceClipboardWithText('Clipboard no longer contains the pasted screenshot')
      await control.command('pasteFile', CHAT_COMPOSER, {
        filename: CHAT_IMAGE,
        mimeType: 'image/tiff',
        value: TIFF_FIXTURE.base64,
      })
      const chatPreview = `${CHAT} [data-testid="attachment-image-preview"]`
      await control.command('waitFor', chatPreview, { timeoutMs: uiTimeoutMs })
      await waitForDecodedImage(control, chatPreview, uiTimeoutMs)
      const stagedChat = await waitForStagedFile(executorHome, 'clipboard-chat.png', uiTimeoutMs)
      assert.deepEqual(pngDimensions(await readFile(stagedChat)), {
        width: TIFF_FIXTURE.width,
        height: TIFF_FIXTURE.height,
      })
      await control.command('click', `${CONTENT} [data-testid="project-space-chat-close"]`)
      await control.command('waitFor', CHAT, { visible: false })

      await control.command('clickWhenEnabled', CREATE_ISSUE)
      await control.command('waitFor', CREATE_PANEL, { visible: true })
      await control.command('fill', CREATE_TITLE, { value: ISSUE_TITLE })

      replaceClipboardWithText('Clipboard changed before the Issue screenshot paste')
      await control.command('pasteFile', CREATE_DESCRIPTION, {
        filename: ISSUE_IMAGE,
        mimeType: 'image/tiff',
        value: TIFF_FIXTURE.base64,
      })
      await control.command('waitFor', CREATE_DIALOG, { text: 'clipboard-issue.png' })
      await control.command(
        'waitFor',
        `${CREATE_DIALOG} [data-testid="issue-detail-attachment-thumbnail-pending-0"]`
      )
      await waitForDecodedImage(
        control,
        `${CREATE_DIALOG} [data-testid="issue-detail-attachment-thumbnail-pending-0"]`,
        uiTimeoutMs
      )

      replaceClipboardWithText('Clipboard changed before the invalid screenshot paste')
      await control.command('pasteFile', CREATE_DESCRIPTION, {
        filename: BROKEN_IMAGE,
        mimeType: 'image/tiff',
        value: Buffer.from('not a TIFF image').toString('base64'),
      })
      await control.command('waitFor', CREATE_DIALOG, { text: BROKEN_IMAGE })
      await waitFor(
        async () =>
          Number(
            await control.command(
              'getElementCount',
              `${CREATE_DIALOG} .issue-detail-attachment-fallback`
            )
          ) >= 1,
        'A failed TIFF conversion did not fall back to the file icon',
        uiTimeoutMs
      )

      await control.command(
        'clickWhenEnabled',
        `${CREATE_DIALOG} [data-testid="cloud-todo-create-confirm"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', `${CONTENT} [data-testid="collaboration-issue-detail"]`, {
        text: ISSUE_TITLE,
        timeoutMs: uiTimeoutMs,
      })

      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const project = (await rpc('projects.list', {})).find(row => row.id === projectId)
      assert.equal(project?.name, PROJECT_NAME, 'The clipboard image fixture was not persisted')
      const issue = await waitFor(
        async () => {
          const rows = await rpc('todos.list', { project_id: project.id })
          return rows.find(row => row.title === ISSUE_TITLE) ?? null
        },
        'The clipboard image fixture Issue was not persisted',
        uiTimeoutMs
      )
      const attachments = await rpc('attachments.list', {
        project_id: project.id,
        item_id: issue.id,
      })
      const converted = attachments.find(row => row.display_name === 'clipboard-issue.png')
      assert.ok(converted, 'The pasted TIFF was not persisted as a PNG attachment')
      assert.equal(converted.content_type, 'image/png')
      const access = await rpc('attachments.access', {
        project_id: project.id,
        item_id: issue.id,
        attachment_id: converted.id,
      })
      const bytes = await readFile(access.path)
      assert.equal(converted.size_bytes, bytes.byteLength)
      assert.equal(converted.sha256, createHash('sha256').update(bytes).digest('hex'))
      assert.deepEqual(pngDimensions(bytes), {
        width: TIFF_FIXTURE.width,
        height: TIFF_FIXTURE.height,
      })
      assert.ok(
        attachments.some(row => row.display_name === BROKEN_IMAGE),
        'The invalid TIFF did not remain available through the file fallback path'
      )

      console.log(
        '[desktop-e2e] PASS clipboard image: both paste entry points converted the pasted TIFF bytes and failures fell back safely'
      )
      return { projectId: project.id, issueId: issue.id }
    },
  }
}
