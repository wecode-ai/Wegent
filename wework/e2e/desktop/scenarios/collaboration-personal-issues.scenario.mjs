import assert from 'node:assert/strict'
import { waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  inCollaborationSidebar,
  revealCollaborationSidebarElement,
} from '../modules/workspace-flows.mjs'

// Stories: start a private Issue without a project, invite a colleague, revoke access,
// find work through the three lists, restore/delete, and associate a real project.
export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud, participant, outsider, participantToken, outsiderToken, project, issue
  const title = `Independent Issue ${process.pid}`
  const sidebar = id => inCollaborationSidebar(`[data-testid="${id}"]`)
  async function request(path, method = 'GET', body, token = cloud.authToken, expected = 200) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
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
      await control.command('fill', '[data-testid="independent-issue-search-people"]', {
        value: participant.user_name,
      })
      await click(control, 'independent-issue-search-submit')
      await wait(control, `[data-testid="independent-issue-invite-${participant.id}"]`)
      await click(control, `independent-issue-invite-${participant.id}`)
      await control.command('select', '[data-testid="independent-issue-assignee"]', {
        value: String(participant.id),
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
      await click(control, `independent-issue-remove-person-${participant.id}`)
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
    },
  }
}
