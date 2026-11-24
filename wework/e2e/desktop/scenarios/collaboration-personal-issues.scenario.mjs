import { verifyLocalProjectMigration } from '../modules/local-project-migration.mjs'
import {
  verifyIndependentIssueDraft,
  verifyIssueConflictRecovery,
  verifyIssueCreationColumns,
  verifyIssueDeviceLayout,
  verifyIssueAssociationRecovery,
  chooseIssueProperty,
  verifyEnglishLinkedIssueLayout,
  pressFocusedIssueKey,
} from '../modules/independent-issue-draft.mjs'
import assert from 'node:assert/strict'
import { waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { verifyIssueChildMode, verifyIssueSendModes } from '../modules/issue-comment-workflow.mjs'
import {
  inCollaborationSidebar,
  revealCollaborationSidebarElement,
} from '../modules/workspace-flows.mjs'

// Stories: start a private Issue without a project, invite a colleague, revoke access,
// find work through the three lists, restore/delete, and associate a real project.
export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let deviceEnvironment
  let cloud,
    participant,
    outsider,
    participantToken,
    outsiderToken,
    project,
    issue,
    sibling,
    homeIssue,
    homeProjectIssue,
    agent,
    group
  const title = `Independent Issue ${process.pid}`
  const sidebar = id => inCollaborationSidebar(`[data-testid="${id}"]`)
  async function request(
    path,
    method = 'GET',
    body,
    token = cloud.authToken,
    expected = 200,
    format = 'json'
  ) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${text}`)
    return format === 'text' ? text : text ? JSON.parse(text) : null
  }
  async function click(control, id) {
    const target = `[data-testid="${id}"]`
    await control.command('scrollIntoView', target)
    await control.command('clickWhenEnabled', target, { timeoutMs: uiTimeoutMs })
  }
  async function navigate(control, id) {
    const target = sidebar(id)
    await revealCollaborationSidebarElement(control, target)
    await control.command('clickWhenEnabled', target, { timeoutMs: uiTimeoutMs })
  }
  const wait = (control, selector, options = {}) =>
    control.command('waitFor', selector, { timeoutMs: uiTimeoutMs, ...options })
  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      deviceEnvironment = value
    },
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      const createUser = name =>
        request(
          '/api/admin/users',
          'POST',
          {
            user_name: name,
            password: 'personal-issues-e2e-only',
            role: 'user',
            auth_source: 'password',
          },
          cloud.authToken,
          201
        )
      participant = await createUser(`personal-participant-${process.pid}`)
      outsider = await createUser(`personal-outsider-${process.pid}`)
      const login = async user => {
        const result = await request('/api/auth/login', 'POST', {
          user_name: user.user_name,
          password: 'personal-issues-e2e-only',
        })
        assert.ok(result.access_token)
        return result.access_token
      }
      participantToken = await login(participant)
      outsiderToken = await login(outsider)
      project = await request(
        '/api/v1/cloud-projects',
        'POST',
        {
          name: `Association target ${process.pid}`,
          task_provider: 'local',
          visibility: 'private',
        },
        cloud.authToken,
        201
      )
      const bot = await request(
        '/api/bots',
        'POST',
        {
          name: `personal-issue-bot-${process.pid}`,
          shell_name: 'Codex',
          namespace: 'default',
          agent_config: { bind_model: 'desktop-e2e-cloud-responses', bind_model_type: 'public' },
          system_prompt: 'Handle the invited Issue when explicitly requested.',
        },
        cloud.authToken,
        201
      )
      agent = await request(
        '/api/teams',
        'POST',
        {
          name: `personal-issue-agent-${process.pid}`,
          bots: [{ bot_id: bot.id, role: 'worker', bot_prompt: '' }],
          namespace: 'default',
          bind_mode: ['task'],
          requires_workspace: false,
          is_active: true,
        },
        cloud.authToken,
        201
      )
      const owner = await request('/api/users/me')
      group = await request(
        `/api/v1/workspaces/${project.workspace_id}/collaboration-groups`,
        'POST',
        {
          name: 'Issue invitation group',
          leader: { kind: 'human', id: String(owner.id) },
          members: [{ kind: 'human', id: String(owner.id) }],
        },
        cloud.authToken,
        201
      )
      sibling = await request(
        `/api/v1/cloud-projects/${project.id}/loop-items`,
        'POST',
        {
          title: 'Narrow list retains a readable title',
          notify_assignee: false,
        },
        cloud.authToken,
        201
      )
      homeIssue = await request(
        '/api/v1/personal-issues',
        'POST',
        {
          title: 'Independent Issue in the home workspace',
          description: 'Open from the same list as project Issues.',
          status: 'pending',
          priority: 'medium',
          assignee_id: owner.id,
          participants: [],
          archived: false,
          due_at: null,
        },
        cloud.authToken,
        200
      )
      assert.ok(
        Math.abs(Date.parse(homeIssue.created_at + 'Z') - Date.now()) < 60_000,
        'The shared storage writer must preserve the personal Issue timestamp convention'
      )
      homeProjectIssue = await request(
        `/api/v1/cloud-projects/${project.id}/loop-items`,
        'POST',
        {
          title: 'Project Issue in the home workspace',
          assignee_user_id: owner.id,
          notify_assignee: false,
        },
        cloud.authToken,
        201
      )
      const homeDetail = await request(`/api/v1/loop-items/${homeIssue.id}`)
      assert.ok(
        Math.abs(Date.parse(homeDetail.created_at) - Date.parse(homeProjectIssue.created_at)) <
          60_000,
        'Issues created together with and without a project must have the same creation time'
      )
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await wait(control, '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await click(control, 'workspace-tab-select-fixed-board')
      await navigate(control, 'collaboration-primary-home')
      const homeList = '[data-testid="personal-home-items-region"]'
      const activeHome = '[data-testid="personal-home-stand-in"] [role="tabpanel"]:not([inert])'
      for (const id of [
        `independent-issue-${homeIssue.id}`,
        `personal-home-issue-${homeProjectIssue.id}`,
      ]) {
        const row = `${homeList} [data-testid="${id}"]`
        await wait(control, row, { visible: true })
        assert.equal(Number(await control.command('getElementCount', row)), 1)
        await wait(
          control,
          `${homeList} table[data-testid="collaboration-issue-table"]:not(:has(thead)) [data-testid="${id}"]`
        )
      }
      await captureScreenshot(control, 'shared-issue-list.png')
      const verifySendModes = (item, commentsPath, name) =>
        verifyIssueSendModes(control, {
          scope: activeHome,
          name,
          capture: captureScreenshot,
          load: async () => ({
            status: (await request(`/api/v1/loop-items/${item.id}`)).status,
            comments: (await request(commentsPath)).length,
          }),
        })
      await click(control, `independent-issue-${homeIssue.id}`)
      await wait(
        control,
        '[data-testid="personal-home-stand-in"] [role="tabpanel"]:not([inert]) [data-testid="independent-issue-dialog"][role="region"] [data-testid="cloud-todo-detail-content"]',
        { visible: true, text: homeIssue.title }
      )
      await wait(control, '[data-testid="independent-issue-dialog"][aria-modal="true"]', {
        visible: false,
      })
      const linkedTasks = '[data-testid="cloud-todo-tasks"]'
      const expectTaskActions = async () => {
        for (const action of ['issue-link-existing-task', 'cloud-todo-create-task']) {
          await wait(control, `${linkedTasks} [data-testid="${action}"]`, { visible: true })
        }
      }
      const expectDiscussionActions = async ({ canMove }) => {
        await wait(
          control,
          '[data-testid="personal-home-stand-in"] [role="tabpanel"]:not([inert]) :is([data-testid="cloud-task-status-created"], [data-testid="cloud-task-status-event-0"])',
          { visible: true, text: '创建' }
        )
        for (const action of [
          'task-comment-attach',
          'task-comment-form-mention',
          'task-comment-form-assignee',
          'task-comment-form-send-actions',
        ]) {
          await wait(control, `[data-testid="task-comment-form"] [data-testid="${action}"]`, {
            visible: true,
          })
        }
        await wait(
          control,
          `${activeHome} [data-testid="task-comment-form"] [data-testid="task-comment-form-move"]`,
          { visible: canMove }
        )
      }
      const expectTaskComposer = async () => {
        await click(control, 'cloud-todo-create-task')
        await wait(control, '[data-testid="work-item-new-task-chat-panel"]', { visible: true })
        await click(control, 'ai-chat-modal-close')
        await wait(control, '[data-testid="work-item-new-task-chat-panel"]', { visible: false })
      }
      await expectTaskActions()
      await expectDiscussionActions({ canMove: false })
      await expectTaskComposer()
      await click(control, 'issue-link-existing-task')
      await wait(control, '[data-testid="issue-existing-task-picker"]', { visible: true })
      await control.command('press', '[data-testid="issue-existing-task-search"]', {
        key: 'Escape',
      })
      await captureScreenshot(control, 'independent-issue-home-detail.png')
      const child = await verifyIssueChildMode(control, {
        scope: activeHome,
        issueId: homeIssue.id,
        name: 'independent-issue',
        capture: captureScreenshot,
        children: async () => (await request('/api/v1/personal-issues?scope=created')).items,
      })
      await click(control, `cloud-todo-open-child-task-${child.id}`)
      await wait(control, `${activeHome} [data-testid="cloud-todo-detail-content"]`, {
        text: child.title,
        visible: true,
      })
      await wait(control, `${activeHome} [data-testid="issue-parent-link"]`, {
        text: homeIssue.title,
        visible: true,
      })
      await captureScreenshot(control, 'independent-issue-child-opened.png')
      await click(control, 'issue-parent-link')
      await wait(control, `${activeHome} [data-testid="cloud-todo-detail-content"]`, {
        text: homeIssue.title,
        visible: true,
      })
      await wait(control, `${activeHome} [data-testid="cloud-todo-open-child-task-${child.id}"]`, {
        visible: true,
      })
      await captureScreenshot(control, 'independent-issue-child-returned.png')
      await verifySendModes(
        homeIssue,
        `/api/v1/personal-issues/${homeIssue.id}/comments`,
        'independent-issue'
      )
      await click(control, 'independent-issue-close')
      await wait(control, '[data-testid="independent-issue-dialog"]', { visible: false })
      await click(control, `personal-home-issue-${homeProjectIssue.id}`)
      await wait(
        control,
        '[data-testid="personal-home-stand-in"] [role="tabpanel"]:not([inert]) [data-testid="cloud-todo-detail-content"]',
        { visible: true, text: homeProjectIssue.title }
      )
      await expectTaskActions()
      await expectDiscussionActions({ canMove: true })
      await expectTaskComposer()
      await captureScreenshot(control, 'project-issue-home-detail.png')
      await verifySendModes(
        homeProjectIssue,
        `/api/v1/cloud-projects/${project.id}/loop-items/${homeProjectIssue.id}/activity-comments`,
        'project-issue'
      )
      await click(control, 'cloud-todo-detail-close')
      await wait(control, '[data-testid="cloud-todo-detail-content"]', { visible: false })
      const before = await request('/api/v1/cloud-projects')
      await verifyIssueConflictRecovery(control, {
        request,
        reopen: () => navigate(control, 'collaboration-primary-create-issue'),
        captureScreenshot,
      })
      await navigate(control, 'collaboration-primary-create-issue')
      await wait(control, '[data-testid="independent-issue-dialog"]')
      await verifyIssueCreationColumns(control)
      await captureScreenshot(control, 'new-issue-shared-layout.png')
      await click(control, 'independent-issue-close')
      await verifyIssueAssociationRecovery(control, {
        request,
        reopen: () => navigate(control, 'collaboration-primary-create-issue'),
      })
      await verifyIndependentIssueDraft(control, {
        request,
        opener: sidebar('collaboration-primary-create-issue'),
        reopen: async () => {
          const target = sidebar('collaboration-primary-create-issue')
          await revealCollaborationSidebarElement(control, target)
          await pressFocusedIssueKey(control, target, 'Enter')
        },
        captureScreenshot,
      })
      await control.command('fill', '[data-testid="independent-issue-title"]', { value: title })
      await control.command('fill', '[data-testid="independent-issue-description"]', {
        value: 'Discuss a company-wide improvement without creating a project.',
      })
      await wait(control, '[data-testid="independent-issue-search-people"]', { visible: true })
      await wait(control, '[data-testid="independent-issue-options"][aria-expanded="false"]')
      // User story: runtime setup is available without blocking a draft or starting work.
      await click(control, 'independent-issue-execution-settings')
      await control.command('waitFor', '[data-testid="settings-default-runner"]', { visible: true })
      await captureScreenshot(control, 'new-issue-optional-runtime.png')
      await click(control, 'independent-issue-save')
      await wait(control, '[data-testid="independent-issue-actions"]')
      await wait(
        control,
        '[data-testid="issue-conversation-drawers"] [data-testid="independent-issue-dialog"][role="region"]',
        { visible: true }
      )
      const mine = await request('/api/v1/personal-issues?scope=created')
      issue = mine.items.find(item => item.title === title)
      assert.ok(issue)
      assert.deepEqual(issue.metadata.participants, [])
      assert.equal(
        (await request('/api/v1/cloud-projects')).items.length,
        before.items.length,
        'Creating an independent Issue must not create a hidden project'
      )
      await request(`/api/v1/personal-issues/${issue.id}`, 'GET', undefined, participantToken, 404)
      await request(
        `/api/v1/personal-issues/${issue.id}/comments`,
        'GET',
        undefined,
        outsiderToken,
        404
      )
      await click(control, 'independent-issue-actions')
      await click(control, 'independent-issue-edit')
      await control.command('fill', '[data-testid="independent-issue-search-people"]', {
        value: `  ${participant.user_name}  `,
      })
      await wait(control, `[data-testid="independent-issue-invite-${participant.id}"]`)
      await control.command('fill', '[data-testid="independent-issue-search-people"]', {
        value: participant.user_name,
      })
      await wait(control, `[data-testid="independent-issue-invite-${participant.id}"]`)
      await click(control, `independent-issue-invite-${participant.id}`)
      await click(control, `issue-participant-assignee-human:${participant.id}`)
      await click(control, 'independent-issue-save')
      await wait(control, '[data-testid="independent-issue-actions"]')
      const invited = await request(
        `/api/v1/personal-issues/${issue.id}`,
        'GET',
        undefined,
        participantToken
      )
      assert.equal(invited.assignee_id, participant.id)
      const bindingPath = `/api/v1/loop-items/${issue.id}/tasks`
      const device = await deviceEnvironment.waitForConnectedAppDevice()
      const taskAddress = {
        deviceId: device.execution_target_id ?? device.device_id,
        taskId: `personal-binding-${process.pid}`,
      }
      await request(bindingPath, 'POST', taskAddress, outsiderToken, 404)
      const binding = await request(bindingPath, 'POST', taskAddress, cloud.authToken, 201)
      assert.equal(binding.cloud_project_id, '')
      assert.deepEqual(
        (await request(bindingPath)).map(row => row.id),
        [binding.id]
      )
      assert.deepEqual(await request(bindingPath, 'GET', undefined, participantToken), [])
      await request(bindingPath, 'GET', undefined, outsiderToken, 404)
      assert.ok(
        (
          await request(
            '/api/v1/personal-issues?scope=assigned',
            'GET',
            undefined,
            participantToken
          )
        ).items.some(item => item.id === issue.id)
      )
      assert.equal(
        (
          await request('/api/v1/personal-issues?scope=created', 'GET', undefined, participantToken)
        ).items.some(item => item.id === issue.id),
        false
      )
      await request(
        `/api/v1/personal-issues/${issue.id}`,
        'DELETE',
        { version: invited.version },
        participantToken,
        404
      )
      await request(
        `/api/v1/personal-issues/${issue.id}/comments`,
        'POST',
        { body: 'Participant progress persisted through the real Backend.' },
        participantToken
      )
      await click(control, 'independent-issue-close')
      await navigate(control, 'collaboration-primary-issues-created')
      await wait(control, '[data-testid="personal-issues-created"]')
      await wait(control, `[data-testid="independent-issue-${issue.id}"]`)
      await click(control, `independent-issue-${issue.id}`)
      await wait(control, '[data-testid="independent-issue-dialog"]', {
        text: 'Participant progress persisted',
      })
      const attachmentName = 'issue-discussion.txt'
      const attachmentContent = 'An attachment added from the shared Issue discussion.'
      await control.command('selectFile', '[data-testid="task-comment-file-input"]', {
        filename: attachmentName,
        mimeType: 'text/plain',
        value: Buffer.from(attachmentContent).toString('base64'),
      })
      await control.command('fill', '[data-testid="independent-issue-comment"]', {
        value: 'Discussion attachment added from the composer.',
      })
      await click(control, 'independent-issue-comment-send')
      await wait(control, '[data-testid="independent-issue-activity-list"]', {
        text: attachmentName,
      })
      const [attachment] = await request(`/api/v1/loop-items/${issue.id}/attachments`)
      assert.equal(attachment.display_name, attachmentName)
      const attachmentPath = `/api/v1/loop-item-attachments/${attachment.id}/content`
      assert.equal(
        await request(attachmentPath, 'GET', undefined, participantToken, 200, 'text'),
        attachmentContent
      )
      await request(attachmentPath, 'GET', undefined, outsiderToken, 404)
      await click(control, 'independent-issue-actions')
      await click(control, 'independent-issue-edit')
      await click(control, `issue-participant-remove-human:${participant.id}`)
      await click(control, 'independent-issue-save')
      await wait(control, '[data-testid="independent-issue-actions"]')
      const revoked = await request(`/api/v1/personal-issues/${issue.id}`)
      assert.equal(revoked.assignee_id, null)
      await request(attachmentPath, 'GET', undefined, participantToken, 404)
      await request(`/api/v1/personal-issues/${issue.id}`, 'GET', undefined, participantToken, 404)
      await request(
        `/api/v1/personal-issues/${issue.id}/comments`,
        'POST',
        { body: 'Denied after revocation' },
        participantToken,
        404
      )
      await click(control, 'independent-issue-actions')
      await click(control, 'independent-issue-archive')
      await click(control, 'independent-issue-actions')
      await wait(control, '[data-testid="independent-issue-archive"]', { text: '恢复' })
      await click(control, 'independent-issue-actions')
      await click(control, 'independent-issue-close')
      await click(control, 'personal-issues-archived')
      await wait(control, `[data-testid="independent-issue-${issue.id}"]`)
      await click(control, `independent-issue-${issue.id}`)
      await click(control, 'independent-issue-actions')
      await click(control, 'independent-issue-archive')
      await click(control, 'independent-issue-actions')
      await wait(control, '[data-testid="independent-issue-archive"]', { text: '归档' })
      await click(control, 'independent-issue-associate')
      await chooseIssueProperty(
        control,
        'independent-issue-project',
        String(project.id),
        project.name
      )
      await click(control, 'independent-issue-project-confirm')
      await wait(control, '[data-testid="independent-issue-dialog"]', { visible: false })
      const moved = await request(`/api/v1/loop-items/${issue.id}`)
      assert.equal(String(moved.cloud_project_id), String(project.id))
      const [movedBinding] = await request(bindingPath)
      assert.equal(movedBinding.id, binding.id)
      assert.equal(String(movedBinding.cloud_project_id), String(project.id))
      await request(`/api/v1/personal-issues/${issue.id}`, 'GET', undefined, participantToken, 404)
      await navigate(control, 'collaboration-primary-home')
      await wait(control, '[data-testid="personal-home"]')
      await wait(control, '[data-testid="personal-home-create"]')
      await wait(control, '[data-testid="personal-home-stand-in"]')
      for (const scope of ['assigned', 'created', 'participating']) {
        await navigate(control, `collaboration-primary-issues-${scope}`)
        await wait(control, `[data-testid="personal-issues-${scope}"]`)
        if (scope === 'created') {
          await wait(control, `[data-testid="personal-home-issue-${issue.id}"]`)
          await click(control, `personal-home-issue-${issue.id}`)
          await wait(
            control,
            '[data-testid="personal-issues-detail"] [data-testid="collaboration-issue-detail"][role="region"]'
          )
          await wait(control, '[data-testid="personal-issues-created"]', { visible: true })
          await wait(control, `[data-testid="personal-home-issue-${sibling.id}"]`)
          await wait(control, `[data-testid="personal-home-issue-${issue.id}"] time[datetime]`)
          const metrics = async selector =>
            JSON.parse(await control.command('getElementMetrics', selector))[0]
          const center = await metrics('[data-testid="personal-issues-created"]')
          const detail = await metrics('[data-testid="personal-issues-detail"]')
          assert.ok(
            center.left + center.width <= detail.left + 1,
            'Drawer must push the list, not cover it'
          )
          await click(control, 'personal-issue-detail-expand')
          await wait(control, '[data-testid="personal-issue-detail-expand"][aria-pressed="true"]')
          await click(control, `personal-home-issue-${sibling.id}`)
          await wait(control, '[data-testid="personal-issue-detail-expand"][aria-pressed="true"]')
          const titleBounds = await metrics(`[data-testid="cloud-todo-card-title-${sibling.id}"]`)
          assert.ok(titleBounds.width >= 90, 'Narrow card title must keep usable width')
          const expandedDetail = await metrics('[data-testid="personal-issues-detail"]')
          assert.ok(
            expandedDetail.width > detail.width,
            'Expanded preference must survive switching Issues'
          )

          await captureScreenshot(control, 'personal-issues-narrow-expanded.png')
          await click(control, 'cloud-todo-detail-close')
          await wait(control, '[data-testid="personal-issues-detail"]', { visible: false })
          await click(control, `personal-issues-project-${project.id}`)
          await wait(
            control,
            `${sidebar(`collaboration-workspace-project-${project.id}`)}[aria-current="page"]`
          )
          await wait(control, '[data-testid="collaboration-board"]')
        }
      }
      await navigate(control, 'collaboration-primary-create-issue')
      await control.command('fill', '[data-testid="independent-issue-title"]', {
        value: `Delete ${title}`,
      })
      await click(control, 'independent-issue-save')
      await wait(control, '[data-testid="independent-issue-actions"]')
      const deletion = (await request('/api/v1/personal-issues?scope=created')).items.find(
        item => item.title === `Delete ${title}`
      )
      assert.ok(deletion)
      await click(control, 'independent-issue-actions')
      await click(control, 'independent-issue-delete')
      await wait(control, '[data-testid="independent-issue-confirm-delete"]')
      await click(control, 'independent-issue-confirm-delete')
      await wait(control, '[data-testid="independent-issue-dialog"]', { visible: false })
      await request(
        `/api/v1/personal-issues/${deletion.id}`,
        'GET',
        undefined,
        cloud.authToken,
        404
      )
      // Story: invite Agents and groups before creating, with an optional project destination.
      const typedTitle = `Typed participants ${process.pid}`
      await navigate(control, 'collaboration-primary-create-issue')
      await control.command('fill', '[data-testid="independent-issue-title"]', {
        value: typedTitle,
      })
      await click(control, 'issue-participant-tab-agent')
      await wait(control, `[data-testid="issue-participant-invite-agent:${agent.id}"]`)
      await click(control, `issue-participant-invite-agent:${agent.id}`)
      await click(control, 'issue-participant-tab-group')
      await wait(control, `[data-testid="issue-participant-invite-group:${group.id}"]`)
      await click(control, `issue-participant-invite-group:${group.id}`)
      await click(control, `issue-participant-assignee-agent:${agent.id}`)
      await click(control, 'independent-issue-save')
      await wait(control, '[data-testid="independent-issue-actions"]')
      const typed = (await request('/api/v1/personal-issues?scope=created')).items.find(
        item => item.title === typedTitle
      )
      assert.ok(typed)
      assert.equal(typed.metadata.resource_participants.length, 2)
      assert.deepEqual(typed.metadata.assignee_resource, { kind: 'agent', id: agent.id })
      for (const resource of typed.metadata.resource_participants) {
        assert.equal(resource.instructions, undefined)
        assert.equal(resource.group_snapshot, undefined)
      }
      await request(`/api/v1/personal-issues/${typed.id}/resources/agent/${agent.id}`)
      await request(
        `/api/v1/personal-issues/${typed.id}/resources/agent/${agent.id}`,
        'GET',
        undefined,
        outsiderToken,
        404
      )
      await click(control, 'independent-issue-close')
      await verifyEnglishLinkedIssueLayout(control, {
        project,
        reopen: () => navigate(control, 'collaboration-primary-create-issue'),
        captureScreenshot,
      })
      await navigate(control, 'collaboration-primary-create-issue')
      await control.command('fill', '[data-testid="independent-issue-title"]', {
        value: `Project selection ${process.pid}`,
      })
      await chooseIssueProperty(
        control,
        'independent-issue-project',
        String(project.id),
        project.name
      )
      await click(control, 'independent-issue-execution-settings')
      await click(control, 'issue-environment-picker-trigger')
      await wait(control, '[data-testid="issue-environment-picker"]')
      await wait(control, '[data-testid="collaboration-project-execution-environment-add"]')
      const appDevice = await deviceEnvironment.waitForConnectedAppDevice()
      const poolPath = `/api/v1/cloud-projects/${project.id}/execution-environments`
      if (!(await request(poolPath)).items.some(row => row.device_id === appDevice.id)) {
        await click(
          control,
          `collaboration-project-execution-environment-candidate-${appDevice.id}`
        )
      }
      await waitForBoardValue(
        async () => (await request(poolPath)).items.some(row => row.device_id === appDevice.id),
        true,
        'Adding a device from the Issue draft must persist its project authorization',
        uiTimeoutMs
      )
      await verifyIssueDeviceLayout(control, appDevice.id)
      await captureScreenshot(control, 'new-issue-project-devices.png')
      await pressFocusedIssueKey(control, '[data-testid="issue-environment-picker"]', 'Escape')
      await wait(control, '[data-testid="issue-environment-picker"]', { visible: false })
      assert.equal(
        await control.command('getValue', '[data-testid="independent-issue-title"]'),
        `Project selection ${process.pid}`,
        'Device setup must preserve the Issue draft'
      )
      await click(control, 'independent-issue-save')
      await wait(control, '[data-testid="independent-issue-dialog"]', { visible: false })
      const selectedProjectIssues = await request(`/api/v1/cloud-projects/${project.id}/loop-items`)
      assert.ok(
        selectedProjectIssues.items.some(item => item.title === `Project selection ${process.pid}`)
      )
      await verifyLocalProjectMigration(control, request, uiTimeoutMs)
    },
  }
}
