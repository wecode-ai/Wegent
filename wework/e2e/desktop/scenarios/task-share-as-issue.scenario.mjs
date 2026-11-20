import assert from 'node:assert/strict'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const prompt = 'Investigate a model error for conversation sharing'
const reply = 'The model error occurs when the response payload is empty.'
const activePane = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const selector = id => `[data-testid="${id}"]`

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, modelResponseTimeoutMs }) {
  let cloud, colleague, colleagueToken, outsiderToken, project, restrictedProject
  async function request(path, { token = cloud.authToken, body, status = 200 } = {}) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const error = response.ok ? '' : await response.clone().text()
    assert.equal(response.status, status, `${path}: ${response.status} ${error}`)
    return response.json()
  }
  const wait = (control, target, options = {}) =>
    control.command('waitFor', target, { timeoutMs: uiTimeoutMs, ...options })
  const click = (control, target) =>
    control.command('clickWhenEnabled', target, { timeoutMs: uiTimeoutMs })

  async function inviteColleague(control) {
    await click(control, selector('issue-participant-add'))
    await control.command('fill', selector('independent-issue-search-people'), {
      value: colleague.user_name,
    })
    await click(control, selector(`independent-issue-invite-${colleague.id}`))
    await click(control, selector('issue-participant-done'))
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
      response.end(createSse([responseCreated(id), assistantMessage(reply), responseCompleted(id)]))
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
      await wait(control, `${save}:disabled`)
      await wait(control, selector('task-issue-share-missing-recipient'), { visible: true })
      await captureScreenshot(control, '02-task-share-dialog.png')
      await inviteColleague(control)
      await control.command('fill', title, { value: 'Model error follow-up' })
      await control.command('fill', description, {
        value: 'Please verify the empty response case.',
      })
      await click(control, selector('task-issue-share-excerpts'))
      await control.command('markElementWithText', `${dialog} label`, {
        text: reply,
        value: 'share-selected-reply',
      })
      const excerpt = `[data-e2e-anchor-id="share-selected-reply"] ${selector('task-issue-share-excerpt')}`
      await click(control, excerpt)
      await wait(control, `${excerpt}:checked`)
      await captureScreenshot(control, '03-task-share-selected-content.png')
      await click(control, save)
      await wait(control, selector('independent-issue-edit'), { visible: true })
      await captureScreenshot(control, '04-task-share-independent-result.png')
      const mine = await request('/v1/personal-issues?scope=created')
      const issue = mine.items.find(item => item.title === 'Model error follow-up')
      assert.ok(issue, 'The shared issue must be saved without a project')
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
      await click(control, selector('independent-issue-close'))
      await wait(control, assistant, { text: reply })

      // Sharing to a project uses its normal creation and visibility rules.
      await click(control, share)
      await wait(control, dialog, { visible: true })
      await inviteColleague(control)
      await control.command('fill', title, { value: 'Project model error follow-up' })
      await control.command('fill', description, { value: 'Review this with the project team.' })
      await selectProject(control, project)
      await wait(control, selector('issue-project-scope'), { visible: true })
      await wait(control, selector('issue-participant-add'), { visible: false })
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
    },
  }
}
