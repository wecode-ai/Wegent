import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import { verifyIssueCreationColumns } from '../modules/independent-issue-draft.mjs'
import { switchPersonalPluginAccount } from '../modules/plugin-personal-uninstall-flow.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
  requestContainsToolOutput,
  selectShellToolCommand,
} from '../modules/response-protocol.mjs'

const prompt = 'Investigate a model error for conversation sharing'
const generatedFilename = 'model-error.txt'
const generatedContent = 'Empty payload reproduction'
const generatedImage = 'preview-example.png'
const imageData = readFileSync(
  new URL('../../../resources/icons/32x32.png', import.meta.url)
).toString('base64')
const reply = 'The model error occurs when the response payload is empty.'
const activePane = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const selector = id => `[data-testid="${id}"]`

export function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workspacePath,
}) {
  let cloud, colleague, colleagueToken, outsiderToken, project, restrictedProject
  async function request(
    path,
    {
      token = cloud.authToken,
      body,
      status = 200,
      method = body === undefined ? 'GET' : 'POST',
    } = {}
  ) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const error = response.ok ? '' : await response.clone().text()
    assert.equal(response.status, status, `${path}: ${response.status} ${error}`)
    return response.json()
  }
  async function selectAttachment(control, filename, content) {
    await control.command('selectFile', selector('task-issue-share-file-input'), {
      filename,
      mimeType: 'text/plain',
      value: Buffer.from(content).toString('base64'),
    })
    await wait(control, selector('task-issue-share-files'), { text: filename })
  }

  async function assertAttachment(path, token, status, expected) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(response.status, status, path)
    if (expected) assert.equal(await response.text(), expected)
  }

  const wait = (control, target, options = {}) =>
    control.command('waitFor', target, { timeoutMs: uiTimeoutMs, ...options })
  const click = (control, target) =>
    control.command('clickWhenEnabled', target, { timeoutMs: uiTimeoutMs })

  async function inviteColleague(control) {
    await control.command('fill', selector('independent-issue-search-people'), {
      value: colleague.user_name,
    })
    await click(control, selector(`independent-issue-invite-${colleague.id}`))
  }

  async function selectProject(control, target) {
    await click(control, selector('independent-issue-project'))
    await control.command('fill', selector('independent-issue-project-search'), {
      value: target.name,
    })
    await click(control, selector(`independent-issue-project-option-${target.id}`))
    await wait(control, `${selector('independent-issue-project')}[data-value="${target.id}"]`)
  }

  return {
    requiresCloudEnvironment: true,
    requiresRemoteExecutor: false,
    async prepareCloud(environment) {
      cloud = environment
      await request('/admin/setup-complete', { body: {} })
      const createUser = async name => {
        const login = { user_name: `${name}-${process.pid}`, password: 'task-share-e2e-only' }
        const user = await request('/admin/users', {
          body: { ...login, role: 'user', auth_source: 'password' },
          status: 201,
        })
        const auth = await request('/auth/login', { body: login })
        assert.ok(auth.access_token)
        return [user, auth.access_token]
      }
      ;[colleague, colleagueToken] = await createUser('share-colleague')
      ;[, outsiderToken] = await createUser('share-outsider')
      project = await request('/v1/cloud-projects', {
        body: {
          name: 'Model Support',
          task_provider: 'local',
          visibility: 'private',
        },
        status: 201,
      })
      restrictedProject = await request('/v1/cloud-projects', {
        body: {
          name: 'Restricted Incident Desk',
          task_provider: 'local',
          visibility: 'private',
          default_issue_security: 'related',
        },
        status: 201,
      })
      for (const target of [project, restrictedProject]) {
        await request(`/v1/cloud-projects/${target.id}/members`, {
          body: { user_id: colleague.id, role: 'Developer' },
          status: 201,
        })
      }
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body).includes(prompt)) return false
      const id = 'task-share-response'
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      const events = requestContainsToolOutput(body)
        ? [
            assistantMessage(
              `${reply}\n\nCheck the response status and compare it with the empty payload.\n\nSave the minimal reproduction as an attachment.\n\n[${generatedFilename}](./${generatedFilename})\n\n[${generatedImage}](./${generatedImage})`
            ),
          ]
        : selectedToolCall(
            'share-generate-file',
            selectShellToolCommand(
              body,
              `node -e "const fs=require('node:fs');const path=require('node:path');const cwd=process.env.WEGENT_TASK_WORKSPACE || process.cwd();fs.writeFileSync(path.join(cwd,'${generatedFilename}'),'${generatedContent}');fs.writeFileSync(path.join(cwd,'${generatedImage}'),Buffer.from('${imageData}','base64'))"`,
              workspacePath
            )
          )
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const composer = `${activePane} [data-testid="chat-message-input"][contenteditable="true"]`
      const share = `${activePane} ${selector('task-share-as-issue')}`
      const dialog = selector('independent-issue-dialog')
      const description = selector('independent-issue-description')
      const save = selector('independent-issue-save')
      const assistant = `${activePane} ${selector('message-assistant')}`
      await wait(control, selector('runtime-chat-section-new-chat-button'), { visible: true })
      await click(control, selector('runtime-chat-section-new-chat-button'))
      await wait(control, composer, { visible: true })
      await selectE2EModel(control)
      await control.command('fill', composer, { value: prompt })
      await click(control, `${activePane} ${selector('send-message-button')}`)
      await wait(control, assistant, { text: reply, timeoutMs: modelResponseTimeoutMs })
      await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.pane?.status?.taskExecution?.running === false,
        'The source task must finish before taking the share snapshot',
        modelResponseTimeoutMs
      )
      await wait(control, share, { visible: true })
      await captureScreenshot(control, '01-task-share-entry.png')

      // A colleague can discuss an excerpt without getting access to the whole task.
      await click(control, share)
      await wait(control, dialog, { visible: true })
      const title = selector('independent-issue-title')
      assert.match(await control.command('getValue', title), /model error/i)
      await wait(control, `${save}:not(:disabled)`)
      await wait(control, selector('independent-issue-search-people'), { visible: true })
      await wait(control, selector('independent-issue-options'), { visible: true })
      await wait(control, 'details:not([open]) > [data-testid="independent-issue-options"]')
      await verifyIssueCreationColumns(control)
      await wait(control, selector('issue-participant-self'), { visible: true })
      assert.match(await control.command('getText', dialog), /仅邀请用户可见|invitees only/)
      await captureScreenshot(control, '02-task-share-dialog.png')
      await click(control, selector('independent-issue-options'))
      await wait(control, 'details[open] > [data-testid="independent-issue-options"]')
      await click(control, selector('independent-issue-options'))
      await wait(control, 'details:not([open]) > [data-testid="independent-issue-options"]')
      await control.command('fill', title, { value: 'Private model error notes' })
      await click(control, save)
      await wait(control, selector('independent-issue-edit'), { visible: true })
      const privateIssue = (await request('/v1/personal-issues?scope=created')).items.find(
        row => row.title === 'Private model error notes'
      )
      assert.ok(privateIssue)
      assert.deepEqual(privateIssue.metadata.participants, [])
      await request(`/v1/personal-issues/${privateIssue.id}`, {
        token: colleagueToken,
        status: 404,
      })
      await captureScreenshot(control, '02a-task-share-private-result.png')
      await click(control, selector('independent-issue-close'))
      await click(control, share)
      await wait(control, dialog, { visible: true })
      await inviteColleague(control)
      await click(control, selector(`issue-participant-assignee-human:${colleague.id}`))
      await control.command('fill', title, { value: 'Model error follow-up' })
      await control.command('fill', description, {
        value: 'Please verify the empty response case.',
      })
      const shareContent = selector('task-issue-share-content')
      const gallery = `${shareContent} ${selector('task-issue-share-conversation-files')}`
      await wait(control, `${gallery} ${selector('task-issue-share-thumbnail-image')}`, {
        visible: true,
      })
      await wait(control, `${shareContent} ${selector('task-issue-share-excerpts')}`, {
        visible: true,
      })
      const metrics = async target =>
        JSON.parse(await control.command('getElementMetrics', target))[0]
      const excerptsBounds = await metrics(selector('task-issue-share-excerpts'))
      const galleryBounds = await metrics(gallery)
      const todoBounds = await metrics(description)
      assert.ok(excerptsBounds.bottom < galleryBounds.top && galleryBounds.bottom < todoBounds.top)
      const projectBounds = await metrics(selector('independent-issue-project'))
      assert.ok(projectBounds.right < galleryBounds.left)
      assert.ok(projectBounds.top > excerptsBounds.top)
      await control.command('markElementWithText', selector('task-issue-share-excerpt'), {
        text: reply,
        value: 'share-selected-reply',
      })
      const excerpt = '[data-e2e-anchor-id="share-selected-reply"]'
      const userExcerpt = `${dialog} ${selector('task-issue-share-excerpt')}:not(${excerpt})`
      await click(control, selector('task-issue-share-select-last'))
      await wait(
        control,
        `${excerpt}[aria-pressed="true"] ${selector('task-issue-share-excerpt-check')}`
      )
      await wait(control, `${userExcerpt}[aria-pressed="false"]`)
      await captureScreenshot(control, '03b-task-share-single-excerpt.png')
      await click(control, selector('task-issue-share-select-all'))
      await wait(control, `${excerpt}[aria-pressed="true"]`)
      await wait(control, `${userExcerpt}[aria-pressed="true"]`)
      const expand = selector('task-issue-share-all-excerpts')
      const replyContent = `${excerpt} [data-testid^="task-issue-share-excerpt-content-"]`
      const collapsedHeight = (await metrics(replyContent)).height
      await click(control, expand)
      await wait(control, `${expand}[aria-expanded="true"]`)
      assert.ok(
        (await metrics(replyContent)).height > collapsedHeight,
        'Expanding reveals the full excerpt'
      )
      await captureScreenshot(control, '03a-task-share-expanded-multiple.png')
      await click(control, expand)
      await wait(control, `${expand}[aria-expanded="false"]`)
      assert.equal((await metrics(replyContent)).height, collapsedHeight)
      await click(control, selector('task-issue-share-select-first'))
      await wait(control, `${userExcerpt}[aria-pressed="false"]`)
      await click(control, excerpt)
      await wait(control, `${excerpt}[aria-pressed="false"]`)
      await click(control, excerpt)
      await wait(control, `${excerpt}[aria-pressed="true"]`)
      await control.command('selectFile', selector('task-issue-share-file-input'), {
        filename: generatedImage,
        mimeType: 'image/png',
        value: readFileSync(
          new URL('../../../resources/icons/128x128.png', import.meta.url)
        ).toString('base64'),
      })
      const uploadedThumbnail = `${selector('task-issue-share-local-file-0')} img`
      await wait(control, uploadedThumbnail, { visible: true })
      await captureScreenshot(control, '03e-task-share-gallery.png')
      const previousSize = await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 390, height: 700 }),
      })
      try {
        await control.command('scrollIntoView', gallery)
        const [narrowGallery] = JSON.parse(await control.command('getElementMetrics', gallery))
        assert.ok(narrowGallery.scrollWidth <= narrowGallery.clientWidth + 1)
        await captureScreenshot(control, '03f-task-share-narrow-gallery.png')
      } finally {
        await control.command('setMainWindowSize', 'body', { value: previousSize })
      }
      await click(control, selector('task-issue-share-preview-local-file-0'))
      await wait(control, `${selector('cloud-file-preview-image')}[alt="preview-example.png"]`, {
        visible: true,
      })
      await captureScreenshot(control, '03c-task-share-image-preview.png')
      const previewClose = selector('cloud-file-preview-close')
      const [closeBounds] = JSON.parse(await control.command('getElementMetrics', previewClose))
      const x = closeBounds.left + closeBounds.width / 2
      const y = closeBounds.top + closeBounds.height / 2
      const headerDrag = `${selector('workbench-main-header')} .electron-titlebar-drag-region`
      if (process.platform === 'darwin') {
        const [dragBounds] = JSON.parse(await control.command('getElementMetrics', headerDrag))
        assert.ok(dragBounds, 'The workbench must have a native titlebar region')
        assert.equal(
          await control.command('getComputedStyleValue', headerDrag, {
            value: '-webkit-app-region',
          }),
          'no-drag',
          `Preview close at (${x}, ${y}) must be clickable over the native titlebar ${JSON.stringify(dragBounds)}`
        )
      }
      await control.command('clickAt', 'body', { value: JSON.stringify({ x, y }) })
      await wait(control, selector('cloud-file-preview-dialog'), { visible: false })
      if (process.platform === 'darwin') {
        assert.equal(
          await control.command('getComputedStyleValue', headerDrag, {
            value: '-webkit-app-region',
          }),
          'drag',
          'Closing the preview restores normal window dragging'
        )
      }
      await click(control, selector('task-issue-share-remove-file-0'))
      await selectAttachment(control, 'draft.txt', 'Do not share this draft')
      await click(control, selector('task-issue-share-remove-file-0'))
      await wait(control, selector('task-issue-share-conversation-files'), {
        text: generatedFilename,
      })
      const fileTile = `${gallery} li:has([title="${generatedFilename}"])`
      const fileSelection = `${fileTile} button[aria-pressed]`
      await click(control, `${fileTile} button[data-testid^="task-issue-share-preview-"]`)
      await wait(control, selector('cloud-file-preview-text'), { text: generatedContent })
      await captureScreenshot(control, '03d-task-share-file-preview.png')
      await click(control, selector('cloud-file-preview-close'))
      await wait(control, selector('cloud-file-preview-dialog'), { visible: false })
      await wait(control, `${fileSelection}[aria-pressed="false"]`)
      await wait(control, `${excerpt}[aria-pressed="true"]`)
      assert.equal(await control.command('getValue', title), 'Model error follow-up')
      await click(control, fileSelection)
      await wait(
        control,
        `${fileSelection}[aria-pressed="true"] ${selector('task-issue-share-selected-file')}`
      )
      assert.match(
        await control.command('getText', selector('task-issue-share-selection-count')),
        /(?:已选 1 个文件 · 1 段会话|Files 1, excerpts 1)/
      )
      await captureScreenshot(control, '03-task-share-selected-content.png')
      await click(control, save)
      await wait(control, selector('independent-issue-edit'), { visible: true })
      await captureScreenshot(control, '04-task-share-independent-result.png')
      const mine = await request('/v1/personal-issues?scope=created')
      const issue = mine.items.find(item => item.title === 'Model error follow-up')
      assert.ok(issue, 'The shared issue must be saved without a project')
      assert.equal(issue.assignee_id, colleague.id)
      assert.equal(
        (await request('/v1/me/issue-assignment-count', { token: colleagueToken })).count,
        1
      )
      assert.equal(
        (await request('/v1/me/issue-assignment-count', { token: outsiderToken })).count,
        0
      )
      assert.match(issue.description, /Please verify the empty response case/)
      assert.ok(issue.description.includes(reply))
      assert.match(issue.description, /(?:助手|Assistant) · /)
      assert.ok(!issue.description.includes(prompt), 'Unchecked user message must stay private')
      const participating = await request('/v1/personal-issues?scope=participating', {
        token: colleagueToken,
      })
      assert.ok(participating.items.some(row => row.id === issue.id))
      await request(`/v1/personal-issues/${issue.id}`, { token: colleagueToken })
      await request(`/v1/personal-issues/${issue.id}`, { token: outsiderToken, status: 404 })
      const files = issue.metadata.share.files
      assert.deepEqual(
        files.map(file => file.filename),
        [generatedFilename]
      )
      assert.ok(!Object.hasOwn(files[0], 'object_key'))
      const attachment = `/v1/personal-issues/${issue.id}/attachments/${files[0].id}`
      await assertAttachment(attachment, colleagueToken, 200, generatedContent)
      await assertAttachment(attachment, outsiderToken, 404)
      const sourcePath = `/v1/personal-issues/${issue.id}/source`
      const source = await request(sourcePath)
      assert.ok(source.device_id && source.task_id)
      const oldest = JSON.parse(
        await control.command('getLocalRuntimeTranscript', 'body', {
          value: JSON.stringify({
            taskId: source.task_id,
            afterCursor: 'start',
            limit: 1,
            includeFullContent: true,
          }),
        })
      )
      assert.equal(oldest.hasMoreBefore, false)
      assert.ok(JSON.stringify(oldest.messages).includes(prompt))
      await request(sourcePath, { token: colleagueToken, status: 404 })
      const oversizedShare = new FormData()
      oversizedShare.set(
        'metadata',
        JSON.stringify({
          request_id: crypto.randomUUID(),
          source: { device_id: source.device_id, task_id: source.task_id, title: source.title },
          issue: { title: 'Share outside attachment count limit' },
        })
      )
      for (let index = 0; index < 101; index++) {
        oversizedShare.append('file', new Blob(), `empty-${index}.txt`)
      }
      const rejected = await fetch(`${cloud.backendUrl}/api/v1/personal-issues/share`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cloud.authToken}` },
        body: oversizedShare,
      })
      assert.equal(rejected.status, 422)
      assert.match((await rejected.json()).detail, /at most 100 attachments/)
      const inbox = await request('/v1/wework-notifications?category=collaboration', {
        token: colleagueToken,
      })
      const notices = inbox.items.filter(
        item => item.kind === 'issue_shared' && item.payload.personalIssueId === issue.id
      )
      assert.equal(notices.length, 1)
      assert.equal(notices[0].url, `wework://personal-issues/${issue.id}`)
      await click(control, selector('independent-issue-close'))
      await click(control, selector('task-linked-issues'))
      await wait(control, selector(`task-linked-issue-${issue.id}`), { visible: true })
      await captureScreenshot(control, '04a-task-linked-issue.png')
      await click(control, selector(`task-linked-issue-${issue.id}`))
      await wait(control, selector('independent-issue-open-source'), { visible: true })
      await click(control, selector('independent-issue-open-source'))
      await wait(control, assistant, { text: reply })
      await wait(control, dialog, { visible: false })
      const revoked = await request(`/v1/personal-issues/${issue.id}`, {
        method: 'PATCH',
        body: {
          title: issue.title,
          description: issue.description,
          status: issue.status,
          priority: issue.priority,
          assignee_id: null,
          due_at: issue.metadata.due_at,
          participants: [],
          version: issue.version,
        },
      })
      await assertAttachment(attachment, colleagueToken, 404)
      await assertAttachment(attachment, cloud.authToken, 200, generatedContent)

      // Sharing to a project uses its normal creation and visibility rules.
      await click(control, share)
      await wait(control, dialog, { visible: true })
      await inviteColleague(control)
      await control.command('fill', title, { value: 'Project model error follow-up' })
      await control.command('fill', description, { value: 'Review this with the project team.' })
      await selectProject(control, project)
      await wait(control, selector('issue-project-scope'), { visible: true })
      await wait(control, selector('independent-issue-search-people'), { visible: true })
      await selectAttachment(control, 'project-notes.txt', 'Project reproduction')
      await captureScreenshot(control, '05-task-share-project-audience.png')
      await click(control, save)
      const viewIssue = selector('task-share-view-project-issue')
      await wait(control, viewIssue, { visible: true })
      await wait(control, assistant, { text: reply })
      await captureScreenshot(control, '06-task-share-project-result.png')
      const projectItems = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
        token: colleagueToken,
      })
      const shared = projectItems.items.find(item => item.title === 'Project model error follow-up')
      assert.ok(shared, 'A project member must see the issue on its board')
      assert.equal(shared.description, 'Review this with the project team.')
      const projectFiles = await request(`/v1/loop-items/${shared.id}/attachments`, {
        token: colleagueToken,
      })
      const [projectFile] = Array.isArray(projectFiles) ? projectFiles : projectFiles.items
      assert.equal(projectFile.display_name, 'project-notes.txt')
      assert.match(projectFile.sha256, /^[a-f0-9]{64}$/)
      await assertAttachment(
        `/v1/loop-item-attachments/${projectFile.id}/content`,
        colleagueToken,
        200,
        'Project reproduction'
      )
      await assertAttachment(
        `/v1/loop-item-attachments/${projectFile.id}/content`,
        outsiderToken,
        404
      )
      const projectInbox = await request('/v1/wework-notifications?category=collaboration', {
        token: colleagueToken,
      })
      assert.ok(
        projectInbox.items.some(
          item => item.kind === 'issue_shared' && item.payload.itemId === shared.id
        )
      )
      await request(`/v1/loop-items/${shared.id}`, { token: outsiderToken, status: 404 })
      const personalAfterProject = await request('/v1/personal-issues?scope=created')
      assert.ok(!personalAfterProject.items.some(item => item.title === shared.title))
      // Restricted projects retain their own visibility and get a truthful receipt.
      await click(control, share)
      await wait(control, dialog, { visible: true })
      await control.command('fill', title, { value: 'Restricted model error follow-up' })
      await selectProject(control, restrictedProject)
      assert.match(
        await control.command('getText', selector('issue-project-scope')),
        /相关人员|people involved/
      )
      assert.match(await control.command('getText', save), /^(创建事项|Create Issue)$/i)
      await captureScreenshot(control, '07-task-share-restricted-audience.png')
      await click(control, save)
      await wait(control, viewIssue, { visible: true })
      await captureScreenshot(control, '08-task-share-restricted-result.png')
      assert.match(
        await control.command('getText', selector('transient-notice')),
        /添加协作者|add collaborators/
      )
      const restricted = await request(`/v1/cloud-projects/${restrictedProject.id}/loop-items`, {
        token: colleagueToken,
      })
      assert.ok(!restricted.items.some(item => item.title === 'Restricted model error follow-up'))
      await click(control, viewIssue)
      await wait(control, selector('cloud-todo-detail-close'), { visible: true })
      await wait(control, 'body', { text: 'Restricted model error follow-up' })
      await wait(control, selector('independent-issue-open-source'), { visible: true })
      await captureScreenshot(control, '09-task-share-project-detail.png')
      await click(control, selector('independent-issue-open-source'))
      await wait(control, assistant, { text: reply })
      await wait(control, selector('cloud-todo-detail-close'), { visible: false })
      await wait(control, selector('task-linked-issues'), { visible: true })
      await captureScreenshot(control, '10-task-share-back-to-conversation.png')
      await switchPersonalPluginAccount(control, { ...cloud, authToken: colleagueToken })
      const badge = selector('workspace-tab-issue-assignment-count')
      await wait(control, badge, { text: '0' })
      await request(`/v1/personal-issues/${issue.id}`, {
        method: 'PATCH',
        body: {
          title: revoked.title,
          description: revoked.description,
          status: revoked.status,
          priority: revoked.priority,
          assignee_id: colleague.id,
          due_at: revoked.metadata.due_at,
          participants: [colleague.id],
          version: revoked.version,
        },
      })
      await wait(control, badge, { text: '1' })
      await captureScreenshot(control, '11-assignee-collaboration-tab.png')
      await click(control, selector('workspace-tab-select-fixed-board'))
      await click(control, selector('collaboration-primary-issues-assigned'))
      await wait(control, 'body', { text: revoked.title })
    },
  }
}
