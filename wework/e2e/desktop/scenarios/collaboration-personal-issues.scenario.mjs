import { verifyLocalProjectMigration } from '../modules/local-project-migration.mjs'
import assert from 'node:assert/strict'
import { waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  inCollaborationSidebar,
  revealCollaborationSidebarElement,
} from '../modules/workspace-flows.mjs'

// Stories: start a private Issue without a project, invite a colleague, revoke access,
// find work through the three lists, restore/delete, and associate a real project.
export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud,
    participant,
    outsider,
    participantToken,
    outsiderToken,
    project,
    issue,
    sibling,
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
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await wait(control, '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await click(control, 'workspace-tab-select-fixed-board')
      const before = await request('/api/v1/cloud-projects')
      await navigate(control, 'collaboration-primary-create-issue')
      await wait(control, '[data-testid="independent-issue-dialog"]')
      await control.command('fill', '[data-testid="independent-issue-title"]', { value: title })
      await control.command('fill', '[data-testid="independent-issue-description"]', {
        value: 'Discuss a company-wide improvement without creating a project.',
      })
      await click(control, 'independent-issue-save')
      await wait(control, '[data-testid="independent-issue-edit"]')
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
      await click(control, 'independent-issue-edit')
      await click(control, 'issue-participant-add')
      await control.command('fill', '[data-testid="independent-issue-search-people"]', {
        value: participant.user_name,
      })
      await wait(control, `[data-testid="independent-issue-invite-${participant.id}"]`)
      await click(control, `independent-issue-invite-${participant.id}`)
      await click(control, 'issue-participant-done')
      await control.command('select', '[data-testid="independent-issue-assignee"]', {
        value: `human:${participant.id}`,
      })
      await click(control, 'independent-issue-save')
      await wait(control, '[data-testid="independent-issue-edit"]')
      const invited = await request(
        `/api/v1/personal-issues/${issue.id}`,
        'GET',
        undefined,
        participantToken
      )
      assert.equal(invited.assignee_id, participant.id)
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
      await click(control, 'independent-issue-edit')
      await click(control, `issue-participant-remove-human:${participant.id}`)
      await click(control, 'independent-issue-save')
      await wait(control, '[data-testid="independent-issue-edit"]')
      const revoked = await request(`/api/v1/personal-issues/${issue.id}`)
      assert.equal(revoked.assignee_id, null)
      await request(`/api/v1/personal-issues/${issue.id}`, 'GET', undefined, participantToken, 404)
      await request(
        `/api/v1/personal-issues/${issue.id}/comments`,
        'POST',
        { body: 'Denied after revocation' },
        participantToken,
        404
      )
      await click(control, 'independent-issue-archive')
      await wait(control, '[data-testid="independent-issue-archive"]', { text: '恢复' })
      await click(control, 'independent-issue-close')
      await click(control, 'personal-issues-archived')
      await wait(control, `[data-testid="independent-issue-${issue.id}"]`)
      await click(control, `independent-issue-${issue.id}`)
      await click(control, 'independent-issue-archive')
      await wait(control, '[data-testid="independent-issue-archive"]', { text: '归档' })
      await click(control, 'independent-issue-associate')
      await waitForBoardValue(
        async () =>
          Number(
            await control.command(
              'getElementCount',
              `[data-testid="independent-issue-project"] option[value="${project.id}"]`
            )
          ),
        1,
        'Project choices did not load',
        uiTimeoutMs
      )
      await control.command('select', '[data-testid="independent-issue-project"]', {
        value: String(project.id),
      })
      await click(control, 'independent-issue-project-confirm')
      await wait(control, '[data-testid="independent-issue-dialog"]', { visible: false })
      const moved = await request(`/api/v1/loop-items/${issue.id}`)
      assert.equal(String(moved.cloud_project_id), String(project.id))
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
      await wait(control, '[data-testid="independent-issue-edit"]')
      const deletion = (await request('/api/v1/personal-issues?scope=created')).items.find(
        item => item.title === `Delete ${title}`
      )
      assert.ok(deletion)
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
      await click(control, 'issue-participant-add')
      await click(control, 'issue-participant-tab-agent')
      await wait(control, `[data-testid="issue-participant-invite-agent:${agent.id}"]`)
      await click(control, `issue-participant-invite-agent:${agent.id}`)
      await click(control, 'issue-participant-tab-group')
      await wait(control, `[data-testid="issue-participant-invite-group:${group.id}"]`)
      await click(control, `issue-participant-invite-group:${group.id}`)
      await click(control, 'issue-participant-done')
      await control.command('select', '[data-testid="independent-issue-assignee"]', {
        value: `agent:${agent.id}`,
      })
      await click(control, 'independent-issue-save')
      await wait(control, '[data-testid="independent-issue-edit"]')
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
      await navigate(control, 'collaboration-primary-create-issue')
      await control.command('fill', '[data-testid="independent-issue-title"]', {
        value: `Project selection ${process.pid}`,
      })
      await wait(control, `[data-testid="independent-issue-project"] option[value="${project.id}"]`)
      await control.command('select', '[data-testid="independent-issue-project"]', {
        value: String(project.id),
      })
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
