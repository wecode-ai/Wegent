import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  expandCollaborationSpaces,
  openDirectProjectCreation,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const selector = id => `[data-testid="${id}"]`
const projectName = `project-people-${process.pid}`

export function createDesktopScenario({ workbenchReadyTimeoutMs }) {
  let cloud, workspace, participant
  async function request(path, method = 'GET', body) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return response.json()
  }
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      participant = await request('/api/admin/users', 'POST', {
        user_name: `project-invitee-${process.pid}`,
        password: 'project-people-e2e-only',
        role: 'user',
        auth_source: 'password',
      })
      workspace = await request('/api/v1/workspaces', 'POST', {
        name: `project-people-group-${process.pid}`,
      })
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', selector('workspace-tab-select-fixed-board'))
      await control.command('waitFor', `${CONTENT} ${selector('collaboration-platform-root')}`, {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await expandCollaborationSpaces(control, CONTENT)
      const tree = `${CONTENT} ${selector(`collaboration-workspace-tree-${workspace.id}`)}`
      await control.command('waitFor', tree)
      await control.command('click', `${tree} .collaboration-workspace-identity`)
      await openDirectProjectCreation(control, CONTENT)
      await control.command('fill', selector('collaboration-project-name-input'), {
        value: projectName,
      })
      await control.command('click', selector('collaboration-project-create-add-collaborator'))
      await control.command('fill', selector('collaboration-project-create-people-search'), {
        value: participant.user_name,
      })
      const result = selector(`collaboration-project-create-member-${participant.id}`)
      await control.command('waitFor', result)
      await control.command('click', result)
      await control.command(
        'waitFor',
        `${selector('collaboration-project-create-dialog')} .collaboration-project-create-collaborator-tokens`,
        {
          text: participant.user_name,
        }
      )
      await control.command('clickWhenEnabled', selector('collaboration-project-create-confirm'))
      await control.command('waitFor', `${CONTENT} ${selector('cloud-project-header-title')}`, {
        text: projectName,
      })
      const projects = await request(`/api/v1/workspaces/${workspace.id}/projects`)
      const project = projects.items.find(item => item.name === projectName)
      assert.ok(project, 'Project creation must persist the project')
      const members = await request(`/api/v1/cloud-projects/${project.id}/members`)
      assert.ok(
        members.some(member => member.user_id === participant.id && member.role === 'Developer'),
        'The selected person must be a project member'
      )
      const groupMembers = await request(`/api/v1/workspaces/${workspace.id}/members`)
      assert.ok(
        !groupMembers.items.some(member => member.user_id === participant.id),
        'Project invitation must not add the person to the parent group'
      )
    },
  }
}
