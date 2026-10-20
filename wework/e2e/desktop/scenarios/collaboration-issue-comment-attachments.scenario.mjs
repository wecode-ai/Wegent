import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { IMAGE_ARTIFACT_BASE64 } from '../modules/shared.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const FORM = `${CONTENT} [data-testid="task-comment-form"]`
const COMPOSER = `${FORM} [data-testid="cloud-task-activity-composer"]`
const SEND = `${FORM} [data-testid="send-message-button"]`
const BADGE = `${FORM} [data-testid="attachment-badge"]`
const ROOT_TEXT = 'Image comment survives upload and reopening'
const REPLY_TEXT = 'Reply keeps both image attachments'
const RECOVERY_TEXT = 'Keep this image draft when its staged file is unavailable'
const PNG = Buffer.from(IMAGE_ARTIFACT_BASE64, 'base64')
const IMAGE_NAMES = ['comment-root.png', 'comment-reply-one.png', 'comment-reply-two.png']
const RECOVERY_IMAGE = 'comment-recovery.png'

/**
 * Real cloud project + desktop staging + upload + Issue persistence regression.
 * Send one image with a root comment and two with a reply, then reload and read
 * each stored image back. Delete only a test-owned staged file to exercise the
 * upload failure: the draft must remain, no comment may be written, and restoring
 * the file must allow exactly one successful submission. A second Issue stays empty.
 */
export function createDesktopScenario({ executorHome, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let backendUrl
  let authToken
  let project
  let issue
  let otherIssue

  async function request(path, options = {}) {
    const response = await fetch(`${backendUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })
    if (!response.ok) assert.fail(`${path}: HTTP ${response.status}: ${await response.text()}`)
    return response
  }

  async function json(path, options) {
    return (await request(path, options)).json()
  }

  function commentsPath(item = issue) {
    return `/api/v1/cloud-projects/${project.id}/loop-items/${item.id}/activity-comments`
  }

  function attachmentsPath(item = issue) {
    return `/api/v1/loop-items/${item.id}/attachments`
  }

  async function openIssue(control, item = issue) {
    await control.command('openWeworkScheme', 'body', {
      value: `wework://boards/${project.id}/issues/${item.id}`,
    })
    await control.command('waitFor', `${CONTENT} [data-testid="cloud-task-activity-${item.id}"]`)
    assert.equal(
      await control.command('getValue', `${CONTENT} [data-testid="cloud-todo-detail-title"]`),
      item.title
    )
    await control.command(
      'waitFor',
      `${CONTENT} [data-testid="cloud-task-activity-${item.id}"] [data-testid="cloud-task-activity-list"] [role="status"]`,
      { visible: false, stableMs: 200 }
    )
    await control.command('waitFor', COMPOSER, { visible: true })
  }

  async function attach(control, filename, count) {
    // The Issue composer exposes paste, including images copied from a browser.
    await control.command('pasteFile', COMPOSER, {
      filename,
      mimeType: 'image/png',
      value: PNG.toString('base64'),
    })
    // Pending previews use the same alt text before native staging completes.
    await control.command('waitFor', `${BADGE} img[alt="${filename}"]`)
    assert.equal(Number(await control.command('getElementCount', BADGE)), count)
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${FORM} [data-testid="uploading-attachment-badge"]`
        )
      ),
      0
    )
  }

  async function persistedComment(control, text, filenames) {
    // Queued replies show their draft text before uploading and persisting it.
    // Wait for the authoritative comment, then assert its exact rendered ID.
    const deadline = Date.now() + uiTimeoutMs
    let comments = []
    let comment
    while (Date.now() < deadline) {
      comments = await json(commentsPath())
      const matches = comments.filter(item => item.body.startsWith(text))
      assert.ok(matches.length <= 1, `Duplicate persisted comments for ${text}`)
      if (matches.length === 1) {
        comment = matches[0]
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(
      comment,
      `Comment was not persisted within ${uiTimeoutMs}ms: ${text}; comments=${JSON.stringify(comments)}`
    )
    const selector = `${CONTENT} [data-testid="cloud-task-activity-message-${comment.id}"]`
    await control.command('waitFor', selector, { text })
    const stored = await json(attachmentsPath())
    for (const filename of filenames) {
      const files = stored.filter(attachment => attachment.display_name === filename)
      assert.equal(files.length, 1, `Expected one durable Issue attachment for ${filename}`)
      const file = files[0]
      assert.ok(
        comment.body.includes(`wegent://attachments/${file.id}`),
        `${filename} lost its comment link`
      )
      await control.command(
        'waitFor',
        `${selector} [data-testid="issue-comment-attachment-${file.id}"]`,
        {
          text: filename,
        }
      )
      assert.equal(file.content_type, 'image/png')
      assert.equal(file.size_bytes, PNG.length)
      assert.equal(file.sha256, createHash('sha256').update(PNG).digest('hex'))
      const download = await request(`/api/v1/loop-item-attachments/${file.id}/content`)
      assert.match(download.headers.get('content-type'), /^image\/png/)
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG)
    }
    return comment
  }

  async function assertComposerCleared(control) {
    await control.command('waitFor', `${COMPOSER}[contenteditable="true"]`)
    assert.equal(await control.command('getAttribute', SEND, { value: 'disabled' }), '')
    assert.equal(await control.command('getValue', COMPOSER), '')
    assert.equal(Number(await control.command('getElementCount', BADGE)), 0)
    assert.equal(Number(await control.command('getElementCount', `${FORM} [role="alert"]`)), 0)
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      const workspace = await json('/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: `Issue images ${process.pid}` }),
      })
      project = await json(`/api/v1/workspaces/${workspace.id}/projects`, {
        method: 'POST',
        body: JSON.stringify({
          projectKey: 'IMAGES',
          name: 'Issue image comment regression',
          taskProvider: 'local',
          providerConfig: {},
          visibility: 'private',
        }),
      })
      const createIssue = title =>
        json(`/api/v1/cloud-projects/${project.id}/loop-items`, {
          method: 'POST',
          body: JSON.stringify({ title }),
        })
      issue = await createIssue('Comment image persistence')
      otherIssue = await createIssue('Other Issue attachment isolation')
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await openIssue(control)

      await control.command('fill', COMPOSER, { value: ROOT_TEXT })
      await attach(control, IMAGE_NAMES[0], 1)
      await control.command('clickWhenEnabled', SEND)
      const root = await persistedComment(control, ROOT_TEXT, [IMAGE_NAMES[0]])
      await assertComposerCleared(control)

      await control.command(
        'click',
        `${CONTENT} [data-testid="cloud-task-activity-reply-toggle-${root.id}"]`
      )
      await control.command('waitFor', `${CONTENT} [data-testid="issue-reply-composer"]`, {
        visible: true,
      })
      await control.command('fill', COMPOSER, { value: REPLY_TEXT })
      await attach(control, IMAGE_NAMES[1], 1)
      await attach(control, IMAGE_NAMES[2], 2)
      await control.command('clickWhenEnabled', SEND)
      const reply = await persistedComment(control, REPLY_TEXT, IMAGE_NAMES.slice(1))
      await control.command(
        'waitFor',
        `${CONTENT} [data-testid="cloud-task-activity-replies-${root.id}"]`,
        {
          text: REPLY_TEXT,
        }
      )
      await assertComposerCleared(control)

      // A missing staged file fails before the comment is persisted.
      await control.command('fill', COMPOSER, { value: RECOVERY_TEXT })
      await attach(control, RECOVERY_IMAGE, 1)
      const stagingRoot = join(executorHome, 'workspace', 'attachments', 'draft')
      const staged = (await readdir(stagingRoot, { recursive: true }))
        .filter(path => basename(path) === RECOVERY_IMAGE)
        .map(path => join(stagingRoot, path))
      assert.equal(staged.length, 1, 'Recovery fixture must own exactly one staged image')
      const bytes = await readFile(staged[0])
      assert.deepEqual(bytes, PNG)
      await rm(staged[0])
      try {
        await control.command('clickWhenEnabled', SEND)
        await control.command('waitFor', `${FORM} [role="alert"]`, { visible: true })
        assert.equal(await control.command('getValue', COMPOSER), RECOVERY_TEXT)
        assert.equal(Number(await control.command('getElementCount', BADGE)), 1)
        assert.equal(
          (await json(commentsPath())).length,
          2,
          'A failed image upload persisted a comment'
        )
        assert.equal(
          (await json(attachmentsPath())).length,
          3,
          'A failed image upload persisted an attachment'
        )
      } finally {
        await writeFile(staged[0], bytes)
      }
      await control.command('clickWhenEnabled', SEND)
      const recovered = await persistedComment(control, RECOVERY_TEXT, [RECOVERY_IMAGE])
      await assertComposerCleared(control)

      await reloadMainWindow(control, 'The desktop did not reconnect after image comment reload')
      await openIssue(control)
      await persistedComment(control, ROOT_TEXT, [IMAGE_NAMES[0]])
      await persistedComment(control, REPLY_TEXT, IMAGE_NAMES.slice(1))
      await control.command(
        'waitFor',
        `${CONTENT} [data-testid="cloud-task-activity-replies-${root.id}"] [data-testid="cloud-task-activity-message-${reply.id}"]`,
        { text: REPLY_TEXT }
      )
      await persistedComment(control, RECOVERY_TEXT, [RECOVERY_IMAGE])
      assert.equal((await json(commentsPath())).length, 3)

      await openIssue(control, otherIssue)
      const activity = `${CONTENT} [data-testid="cloud-task-activity-${otherIssue.id}"]`
      const activityText = await control.command('getText', activity)
      for (const text of [ROOT_TEXT, REPLY_TEXT, RECOVERY_TEXT, ...IMAGE_NAMES, RECOVERY_IMAGE]) {
        assert.equal(activityText.includes(text), false, `Other Issue leaked ${text}`)
      }
      for (const comment of [root, reply, recovered]) {
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              `${activity} [data-testid="cloud-task-activity-message-${comment.id}"]`
            )
          ),
          0
        )
      }
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${activity} [data-testid^="issue-comment-attachment-"]`
          )
        ),
        0
      )
      await assertComposerCleared(control)
      assert.deepEqual(await json(commentsPath(otherIssue)), [])
      assert.deepEqual(await json(attachmentsPath(otherIssue)), [])
      assert.notEqual(root.id, reply.id)
      console.log(
        '[e2e] Issue image comments: root, multiple-image reply, failure recovery, reload and isolation passed'
      )
    },
  }
}
